import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, streamSse } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem,
    ModelChoice, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';
import { mapMiMoCodeSseEvent, MiMoCodeMapperState } from './events';
import { listMiMoCodeModelChoices, organizeMiMoCodeModelChoices, selectMiMoCodeModelChoice } from './modelPicker';
import { normalizeMiMoToolPart } from './toolParts';
import { listOpenCodeModelChoices } from '../opencode/modelPicker';
import { parseSlashCommand } from '../slashCommands';
import {
    bindMiMoCodeSessionWorkspace,
    boundMiMoCodeSessionWorkspace,
    decorateMiMoCodeSessions,
    KnownMiMoCodeSession,
    listMiMoCodeSessions,
    withDirectory,
    workspaceDirectory,
} from './sessionApi';

function mimoConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.mimocode');
}

function mimoHome(): string {
    const raw = mimoConfig().get<string>('home') || '';
    if (raw) {
        if (raw === '~' || raw === '~/') return process.env.HOME || raw;
        if (raw.startsWith('~/')) return path.join(process.env.HOME || '~', raw.slice(2));
        return raw;
    }
    // Auto-discover: prefer XDG data dir (where sessions DB lives), fall back to config dir
    const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
    const dataDir = path.join(xdgData, 'mimocode');
    try { fs.accessSync(dataDir); return dataDir; } catch {}
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '~', '.config');
    const configDir = path.join(xdgConfig, 'mimocode');
    try { fs.accessSync(configDir); return configDir; } catch {}
    return path.join(process.env.HOME || '~', '.mimocode-junction');
}

function mimoBinaryPath(): string {
    const configured = mimoConfig().get<string>('binaryPath');
    if (configured) return configured;
    // Auto-discover from PATH
    try {
        const { execSync } = require('child_process');
        const resolved = execSync('which mimo 2>/dev/null', { encoding: 'utf8' }).trim();
        if (resolved) return resolved;
    } catch {}
    return 'mimo';
}

function mimoServerUrl(): string {
    return (mimoConfig().get<string>('serverUrl') || '').trim();
}

function stripJsonComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readJsonLike(file: string): any | null {
    try {
        return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch {
        return null;
    }
}

function addProviderKeysFromFile(out: Set<string>, file: string): void {
    const data = readJsonLike(file);
    const provider = data?.provider;
    if (provider && typeof provider === 'object') {
        for (const id of Object.keys(provider)) out.add(id);
    }
}

function addAuthKeysFromFile(out: Set<string>, file: string): void {
    const data = readJsonLike(file);
    if (data && typeof data === 'object') {
        for (const id of Object.keys(data)) out.add(id);
    }
}

function manualMimoProviderIds(): Set<string> {
    const out = new Set<string>();
    const home = mimoHome();
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '~', '.config');
    for (const file of [
        path.join(home, 'config', 'mimocode.json'),
        path.join(home, 'config', 'mimocode.jsonc'),
        path.join(xdgConfig, 'mimocode', 'mimocode.json'),
        path.join(xdgConfig, 'mimocode', 'mimocode.jsonc'),
    ]) {
        addProviderKeysFromFile(out, file);
    }
    for (const file of [
        path.join(home, 'auth.json'),
        path.join(xdgConfig, 'mimocode', 'auth.json'),
    ]) {
        addAuthKeysFromFile(out, file);
    }
    return out;
}

/** Sync best-effort: is MiMoCode usable (resolvable binary to `serve`)? Lets a
 *  configured-but-not-running mimo read "Switch bridge" instead of "setup
 *  required" — connect() spawns the server on switch. Not in isConnected(). */
function mimoInstalled(): boolean {
    try { const b = mimoBinaryPath(); return path.isAbsolute(b) && fs.existsSync(b); } catch { return false; }
}

export class MiMoCodeBridge extends EventEmitter implements ChatBridge {
    readonly id = 'mimocode';
    readonly label = 'MiMoCode';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: true,
        steering: false,
        usage: false,
        tools: true,
        timelineInterleaves: true,
    };

    private serverUrl: string | null = null;
    private serverPort: number | null = null;
    private serverProcess: ChildProcess | null = null;
    private externalServer = false;
    private activeSessionId: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, KnownMiMoCodeSession>();
    private activeAbortController: AbortController | null = null;
    private sessionContextInjected = new Set<string>();
    private _lastUsage?: { inputTokens?: number; outputTokens?: number };
    private commandCache: Array<{ name: string; description?: string }> = [];

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        // Restore known sessions from workspaceState
        const saved = this.context.workspaceState.get<Array<[string, KnownMiMoCodeSession]>>(
            'junction.mimocode.knownSessions',
        );
        if (saved) {
            this.knownSessions = new Map(saved);
        }
        this.activeSessionId = this.context.workspaceState.get<string | null>(
            'junction.mimocode.activeSessionId',
            null,
        );
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    async connect(): Promise<boolean> {
        try {
            await this.ensureServer();
            this.loadCommands().catch(() => {});
            this.emit('connected');
            return true;
        } catch (err) {
            Logger.getInstance().warn('MiMoCode bridge connect failed', err);
            this.emit('disconnected');
            return false;
        }
    }

    disconnect(): void {
        this.stopServer();
        this.emit('disconnected');
    }

    isConnected(): boolean {
        return this.serverUrl !== null && (this.externalServer || this.serverProcess !== null);
    }

    async initializeWorkspace(): Promise<void> {
        // MiMoCode initializes lazily on first request
    }

    async registerRuntimeIntegrations(): Promise<void> {
        // No VS Code runtime integrations needed — purely HTTP bridge
    }

    async configure(): Promise<void> {
        await vscode.commands.executeCommand('junction.openSettings');
    }

    // ── Session management ─────────────────────────────────────────────────

    getCurrentSessionKey(): string | null {
        return this.activeSessionId;
    }

    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> {
        const map = new Map<string, vscode.Uri>();
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder && this.activeSessionId) {
            map.set(this.activeSessionId, folder.uri);
        }
        return map;
    }

    setActiveSession(folderUri: vscode.Uri, key: string): void {
        this.activeSessionId = key;
        this.persistSessions();
    }

    bindSessionWorkspace(sessionKey: string | null | undefined, folderUri?: vscode.Uri): void {
        bindMiMoCodeSessionWorkspace(this.context, this.id, sessionKey, folderUri);
    }

    boundSessionWorkspace(sessionKey: string | null | undefined): vscode.Uri | undefined {
        return boundMiMoCodeSessionWorkspace(this.context, this.id, sessionKey);
    }

    async createChat(folderUri?: vscode.Uri): Promise<string> {
        await this.ensureServer();
        const res = await jsonRequest<any>(withDirectory(this.serverUrl!, 'session', folderUri), {
            method: 'POST',
            body: {
                ...(this.selection.modelId ? { model: this.selection.modelId } : {}),
                metadata: { junctionBridge: this.id },
            },
            timeoutMs: 15000,
        });
        const id = String(res?.id || res?.session?.id || '');
        if (!id) throw new Error('MiMoCode did not return session id');
        this.activeSessionId = id;
        this.knownSessions.set(id, {
            title: `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
            model: this.selection.modelId,
            workspaceUri: folderUri?.fsPath || workspaceDirectory(),
        });
        this.persistSessions();
        return id;
    }

    async listSessions(
        _scope: ChatScope,
        includeArchived: boolean,
        archivedKeys: ReadonlySet<string>,
    ): Promise<BridgeSession[]> {
        if (this.serverUrl) {
            try {
            const sessions = await listMiMoCodeSessions({
                    baseUrl: this.serverUrl,
                    bridgeId: this.id,
                    activeSessionId: this.activeSessionId,
                    includeArchived,
                    archivedKeys,
                    knownSessions: this.knownSessions,
                });
                if (sessions.length > 0) {
                    if (!this.activeSessionId || !sessions.some((s) => s.key === this.activeSessionId)) this.activeSessionId = sessions[0].key;
                    this.persistSessions();
                    return sessions;
                }
            } catch {
                // Fall through to local
            }
        }
        return [...this.knownSessions.entries()]
            .filter(([key]) => includeArchived || !archivedKeys.has(key))
            .map(([key, value]) => ({
                key,
                title: value.title,
                model: value.model,
                isActive: key === this.activeSessionId,
                isArchived: archivedKeys.has(key),
                groupId: 'recent',
                groupLabel: 'Recent',
                workspaceUri: value.workspaceUri,
                workspaceName: value.workspaceName,
            }));
    }

    async listWorkspaceSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>, currentFolder?: vscode.Uri): Promise<BridgeSession[]> {
        const sessions = await this.listSessions('all', includeArchived, archivedKeys);
        return decorateMiMoCodeSessions({
            context: this.context,
            bridgeId: this.id,
            sessions,
            scope,
            currentFolder,
        });
    }

    async renameSession(key: string, label: string): Promise<void> {
        if (this.serverUrl) {
            await jsonRequest(withDirectory(this.serverUrl, `session/${encodeURIComponent(key)}`), {
                method: 'PATCH',
                body: { title: label },
                timeoutMs: 5000,
            }).catch(() => undefined);
        }
        const existing = this.knownSessions.get(key) ?? { title: label, model: this.selection.modelId };
        existing.title = label;
        this.knownSessions.set(key, existing);
        this.persistSessions();
    }

    async getSessionHistory(): Promise<any> {
        if (!this.activeSessionId) return { messages: [] };
        try {
            await this.ensureServer();
            const res = await jsonRequest<any>(
                withDirectory(this.serverUrl!, `session/${encodeURIComponent(this.activeSessionId)}/message`),
                { timeoutMs: 10000 },
            );
            // MiMoCode returns [{ info: { role }, parts: [...] }] (flat array)
            const rawMessages = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
            captureBridgeHistoryDebug(this.id, 'history-native', {
                operation: 'getSessionHistory.http',
                sessionKey: this.activeSessionId,
                inputCount: rawMessages.length,
                inputMessages: rawMessages,
            });
            const messages: any[] = [];
            for (const msg of rawMessages) {
                if (!msg) continue;
                // Role lives in info.role, not msg.role
                const role = msg.info?.role ?? msg.role;
                if (role !== 'user' && role !== 'assistant') continue;

                if (role === 'user') {
                    // User messages: extract text content
                    let content = '';
                    const parts = Array.isArray(msg.parts) ? msg.parts : [];
                    for (const part of parts) {
                        if (typeof part === 'string') content += part;
                        else if (part?.type === 'text' && part.text) content += part.text;
                    }
                    if (!content && typeof msg.content === 'string') content = msg.content;
                    messages.push({ role, content });
                } else {
                    // Assistant messages: return raw parts array for rebuildTurnsFromGatewayHistory
                    const rawParts = Array.isArray(msg.parts) ? msg.parts : (Array.isArray(msg.content) ? msg.content : []);
                    const content: any[] = [];
                    for (const part of rawParts) {
                        if (!part || typeof part !== 'object') continue;
                        if (part.type === 'reasoning' || part.type === 'thinking') {
                            content.push({ type: 'reasoning', text: part.text || '' });
                        } else if (part.type === 'text' && part.text) {
                            content.push({ type: 'text', text: part.text });
                        } else if (part.type === 'tool') {
                            const tool = normalizeMiMoToolPart(part);
                            content.push({
                                type: 'toolCall',
                                name: tool.name,
                                toolCallId: tool.callId,
                                arguments: tool.args,
                                result: tool.result,
                                isError: tool.isError,
                            });
                        }
                    }
                    if (content.length > 0) {
                        messages.push({ role, content });
                    }
                }
            }
            captureBridgeHistoryDebug(this.id, 'history-normalized', {
                operation: 'getSessionHistory.http',
                sessionKey: this.activeSessionId,
                outputCount: messages.length,
                outputMessages: messages,
            });
            return { messages };
        } catch (err) {
            Logger.getInstance().warn('Failed to fetch MiMoCode session history', err);
            return { messages: [] };
        }
    }

    // ── Messaging ──────────────────────────────────────────────────────────

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        await this.ensureServer();
        if (!this.activeSessionId) await this.createChat(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined);
        const runId = this.activeSessionId!;
        const sessionKey = runId;
        captureBridgeDebug(this.id, 'request', {
            operation: 'sendChatMessage',
            sessionKey,
            runId,
            message,
            context,
            modelId: this.selection.modelId,
            thinking: this.selection.thinking,
        });
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });

        if (this.activeAbortController) this.activeAbortController.abort();
        this.activeAbortController = new AbortController();
        const signal = this.activeAbortController.signal;

        // Track whether the request was cancelled by the user vs. our cleanup
        let cancelled = false;

        // /event SSE runs in parallel for real-time streaming; /session/:id/message blocks until done
        const eventsDone = this.subscribeEventStream(runId, sessionKey, signal);

        try {
            const directory = this.workspacePath();
            const modelId = this.selection.modelId;
            const thinking = this.selection.thinking;
            const needsContext = directory && !this.sessionContextInjected.has(runId);
            if (needsContext) this.sessionContextInjected.add(runId);
            const res = await jsonRequest<any>(
                withDirectory(this.serverUrl!, `session/${encodeURIComponent(runId)}/message`, context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined),
                {
                    method: 'POST',
                    body: {
                        parts: [{ type: 'text', text: message }],
                        ...(needsContext ? { system: `Working directory: ${directory}` } : {}),
                        ...(modelId ? { model: modelId } : {}),
                        ...(thinking && thinking !== 'off' ? { thinking: true } : {}),
                    },
                    signal,
                    timeoutMs: 300000,
                },
            );
            // Emit final full text from response parts (covers anything the event stream missed)
            const responseParts: any[] = Array.isArray(res?.parts) ? res.parts : [];
            const fullText = responseParts
                .filter((p: any) => p?.type === 'text' && p.text)
                .map((p: any) => p.text)
                .join('');
            if (fullText) {
                this.emit('stream', { type: 'agent_message', runId, sessionKey, text: fullText });
            }
        } catch {
            cancelled = true;
        } finally {
            // Abort the SSE stream now that the POST is done — the global /event
            // endpoint stays open indefinitely, so without this the promise never
            // resolves and sendChatMessage blocks all subsequent messages.
            if (!signal.aborted) this.activeAbortController?.abort();
            if (this.activeAbortController?.signal === signal) {
                this.activeAbortController = null;
            }
            await eventsDone.catch(() => {});
        }

        if (!cancelled) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey, usage: this._lastUsage || { inputTokens: 0, outputTokens: 0 } });
            this._lastUsage = undefined;
        }
        return { session_id: runId };
    }

    async executeSlashCommand(command: string, context?: BridgeContext): Promise<any> {
        const parsed = parseSlashCommand(command);
        if (!parsed) return this.sendChatMessage(command, context);
        await this.ensureServer();
        if (!this.activeSessionId) await this.createChat(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined);
        const runId = this.activeSessionId!;
        const sessionKey = runId;
        captureBridgeDebug(this.id, 'request', {
            operation: 'executeSlashCommand',
            sessionKey,
            runId,
            command,
            parsed,
            context,
        });
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });
        if (this.activeAbortController) this.activeAbortController.abort();
        this.activeAbortController = new AbortController();
        const signal = this.activeAbortController.signal;
        const eventsDone = this.subscribeEventStream(runId, sessionKey, signal, parsed.name);
        let cancelled = false;
        try {
            await jsonRequest<any>(
                withDirectory(this.serverUrl!, `session/${encodeURIComponent(runId)}/command`, context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined),
                {
                    method: 'POST',
                    body: { command: parsed.name, arguments: parsed.args || '' },
                    signal,
                    timeoutMs: 300000,
                },
            );
        } catch {
            cancelled = true;
        } finally {
            if (!signal.aborted) this.activeAbortController?.abort();
            if (this.activeAbortController?.signal === signal) this.activeAbortController = null;
            await eventsDone.catch(() => {});
        }
        if (!cancelled) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey, usage: this._lastUsage || { inputTokens: 0, outputTokens: 0 } });
            this._lastUsage = undefined;
        }
        return { session_id: runId };
    }

    private subscribeEventStream(runId: string, sessionKey: string, signal: AbortSignal, commandName?: string): Promise<void> {
        const state: MiMoCodeMapperState = { reasoningParts: new Set(), reasoningAccum: new Map(), textAccum: new Map(), commandName };
        return streamSse(
            `${this.serverUrl}/event`,
            { method: 'GET', signal, timeoutMs: 0 },
            (event) => {
                // Session-gate: skip events for other sessions BEFORE mapping
                let payload: any = {};
                try { payload = JSON.parse(event.data); } catch { return; }
                const props = payload.properties ?? {};
                if (props.sessionID && props.sessionID !== runId) return;

                captureBridgeDebug(this.id, 'native', {
                    operation: 'subscribeEventStream.sse',
                    sessionKey,
                    runId,
                    eventName: event.event,
                    data: event.data,
                });
                const mapped = mapMiMoCodeSseEvent(runId, '', event.data, state);

                if (mapped.usage) this._lastUsage = mapped.usage;
                captureBridgeDebug(this.id, 'normalized', {
                    operation: 'subscribeEventStream.sse',
                    sessionKey,
                    runId,
                    eventName: event.event,
                    mapped,
                });
                for (const evt of mapped.events) {
                    this.emit('stream', { ...evt, sessionKey });
                }
            },
        ).catch(() => {});
    }

    async stopRun(sessionKeyArg?: string, runIdArg?: string): Promise<void> {
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
        }
        const sessionKey = sessionKeyArg || this.activeSessionId;
        if (sessionKey) {
            // Best-effort server-side abort — ignore errors
            jsonRequest(`${this.serverUrl}/session/${encodeURIComponent(sessionKey)}/abort`, {
                method: 'POST',
                timeoutMs: 3000,
            }).catch(() => {});
            this.emit('stream', {
                type: 'agent_lifecycle',
                phase: 'cancelled',
                runId: runIdArg || sessionKey,
                sessionKey,
            });
        }
    }

    async getUsage(): Promise<any> {
        return {};
    }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        // MiMoCode doesn't have a native steer/interject API yet.
        // For now, steering is disabled (canSteer returns false).
        return false;
    }

    canSteer(): boolean {
        return false;
    }

    canAdminInject(): boolean {
        return false;
    }

    // ── Model / Agent selection ────────────────────────────────────────────

    setSelection(selection: BridgeSelectionState): void {
        this.selection = { ...this.selection, ...selection };
    }

    getSelection(): BridgeSelectionState {
        const activeModel = this.activeSessionId ? this.knownSessions.get(this.activeSessionId)?.model : undefined;
        return { ...this.selection, ...(activeModel ? { modelId: activeModel } : {}) };
    }

    async listModelChoices(
        selectedModel?: string,
        selectedThinking?: string,
    ): Promise<ModelChoice[]> {
        try {
            await this.ensureServer();
            if (this.serverUrl) {
                const live = await listOpenCodeModelChoices(this.serverUrl, selectedModel, selectedThinking);
                if (live.length) return organizeMiMoCodeModelChoices(live, manualMimoProviderIds());
            }
        } catch (err) {
            Logger.getInstance().warn('MiMoCode live model list failed; falling back to static list', err);
        }
        return listMiMoCodeModelChoices(selectedModel, selectedThinking);
    }

    async selectModelChoice(data: any): Promise<{
        display: string;
        modelId: string;
        thinking?: string;
    } | null> {
        const selected = selectMiMoCodeModelChoice(data, this.selection);
        if (!selected) return null;
        const { modelId, thinking } = selected;
        this.setSelection({ modelId, thinking });
        if (this.activeSessionId) {
            const known = this.knownSessions.get(this.activeSessionId)
                ?? { title: this.activeSessionId };
            known.model = modelId;
            this.knownSessions.set(this.activeSessionId, known);
            this.persistSessions();
        }
        return selected;
    }

    // ── Environment / agent picker ─────────────────────────────────────────

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const running = this.isConnected();
        const configured = mimoServerUrl();
        const detected = configured !== '' || mimoInstalled();
        const usable = running || detected;
        const port = this.serverPort ? String(this.serverPort) : '?';
        if (!usable) {
            return [{
                id: 'mimocode:select-home',
                label: 'Set path manually…',
                description: 'Browse for the MiMoCode config directory',
                section: 'MiMoCode',
                icon: 'folder',
                setup: true,
            }, {
                id: 'mimocode:settings',
                label: 'Configure MiMoCode…',
                description: 'Bridge settings',
                section: 'MiMoCode',
                icon: 'gear',
                setup: true,
            }];
        }
        return [
            {
                id: 'mimocode:managed',
                label: configured ? `MiMo@${new URL(configured).host}` : (running ? `MiMo@mimocode:${port}` : 'MiMoCode ready'),
                description: running
                    ? (configured ? `External server at ${configured}` : 'Managed server running')
                    : (configured ? `External: ${configured}` : 'Server starts on switch'),
                section: 'MiMoCode',
                icon: 'hubot',
                checked: running,
                setup: !detected,
            },
            {
                id: 'mimocode:settings',
                label: 'Configure MiMoCode…',
                description: 'Bridge settings',
                section: 'MiMoCode',
                icon: 'gear',
                setup: true,
            },
        ];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        const id = String(data.id ?? '');
        if (id === 'mimocode:settings') { await this.configure(); return; }
        if (id === 'mimocode:select-home') {
            const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
            const defaultUri = vscode.Uri.file(path.join(xdgData, 'mimocode'));
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: 'Set MiMoCode path manually',
                defaultUri,
            });
            if (result?.[0]) {
                await mimoConfig().update('home', result[0].fsPath, vscode.ConfigurationTarget.Global);
                await this.connect();
            }
        }
    }

    getEnvironmentLabel(): string {
        const home = mimoHome();
        const dirName = path.basename(home);
        if (dirName === 'mimocode') {
            // XDG dir — try to find agent name from config or default
            const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '~', '.config');
            const configFile = path.join(xdgConfig, 'mimocode', 'config.yaml');
            try {
                const content = fs.readFileSync(configFile, 'utf8');
                const nameMatch = content.match(/^#\s*(\S+)/m);
                if (nameMatch) return nameMatch[1];
            } catch {}
            return 'MiMo';
        }
        // Stripped prefix: ~/.mimocode-junction → junction
        const match = dirName.match(/^mimocode[_-]?(.+)/);
        return match ? match[1] : dirName;
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const p = prefix.replace(/^\//, '').toLowerCase();
        const fallback = [
            { name: 'help', description: 'Show MiMoCode help' },
            { name: 'status', description: 'Show MiMoCode server status' },
            { name: 'config', description: 'Show MiMoCode bridge config' },
        ];
        const source = this.commandCache.length ? this.commandCache : fallback;
        return source.filter((item) => !p || item.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null {
        return null;
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private persistSessions(): void {
        const data = Array.from(this.knownSessions.entries());
        this.context.workspaceState.update('junction.mimocode.knownSessions', data);
        this.context.workspaceState.update(
            'junction.mimocode.activeSessionId',
            this.activeSessionId,
        );
    }

    private workspacePath(): string {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder?.uri.fsPath || process.cwd();
    }

    private async loadCommands(): Promise<void> {
        if (!this.serverUrl) return;
        try {
            const list: any[] = await jsonRequest(`${this.serverUrl}/command`, { timeoutMs: 3000 }) || [];
            this.commandCache = list
                .map((c) => ({ name: String(c.name || '').replace(/^\//, ''), description: c.description }))
                .filter((c) => c.name);
        } catch {
            this.commandCache = [];
        }
    }

    // ── Server lifecycle ──────────────────────────────────────────────────

    private async ensureServer(): Promise<void> {
        const configured = mimoServerUrl();

        // External server: connect to pre-running instance, never spawn.
        if (configured) {
            if (this.serverUrl === configured) {
                try {
                    await jsonRequest(`${this.serverUrl}/global/health`, { timeoutMs: 2000 });
                    return;
                } catch {
                    this.serverUrl = null;
                }
            }
            await jsonRequest(`${configured}/global/health`, { timeoutMs: 5000 });
            this.serverUrl = configured;
            this.serverPort = parseInt(new URL(configured).port || '80', 10);
            this.externalServer = true;
            return;
        }

        // Managed: health-check existing spawn, or start fresh.
        if (this.serverUrl) {
            try {
                await jsonRequest(`${this.serverUrl}/global/health`, { timeoutMs: 2000 });
                return;
            } catch {
                this.serverUrl = null;
            }
        }
        this.externalServer = false;
        // Auto-detect before spawning: config sniffer then port scan
        const detected = await mimoAutoDetect(300);
        if (detected) {
            this.serverUrl = detected;
            this.serverPort = parseInt(new URL(detected).port || '80', 10);
            this.externalServer = false;
            return;
        }
        await this.startServer();
    }

    private async startServer(): Promise<void> {
        const binary = mimoBinaryPath();
        const home = mimoHome();

        // Ensure home directory exists
        await fs.promises.mkdir(home, { recursive: true });

        Logger.getInstance().info(`MiMoCode: starting server (${binary} serve)`);

        // Spawn mimo serve on a random port
        const child = spawn(binary, [
            'serve',
            '--hostname', '127.0.0.1',
            '--port', '0',
        ], {
            cwd: this.workspacePath(),
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                HOME: home,
                OPENCODE_HOME: home,
                MIMOCODE_HOME: home,
                MIMOCODE_WORKSPACE_ID: `junction-${Math.random().toString(36).slice(2, 8)}`,
            },
        });

        this.serverProcess = child;

        // Parse stdout for the server URL
        let stdout = '';
        const urlPromise = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`MiMoCode server start timed out after 60s`));
            }, 60000);

            child.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString();
                // Look for "listening on http://..." or similar
                const match = stdout.match(/listening on (https?:\/\/[\d.:]+)/);
                if (match) {
                    clearTimeout(timeout);
                    resolve(match[1]);
                }
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString();
                const match = stdout.match(/listening on (https?:\/\/[\d.:]+)/);
                if (match) {
                    clearTimeout(timeout);
                    resolve(match[1]);
                }
            });

            child.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            child.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`MiMoCode server exited with code ${code}`));
                }
            });
        });

        try {
            const url = await urlPromise;
            this.serverUrl = url;
            this.serverPort = parseInt(new URL(url).port, 10);

            // Poll health check until ready
            for (let i = 0; i < 30; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                try {
                    await jsonRequest(`${url}/global/health`, { timeoutMs: 2000 });
                    Logger.getInstance().info(`MiMoCode server ready at ${url}`);
                    return;
                } catch {
                    // Still starting up
                }
            }
            throw new Error('MiMoCode server health check timed out');
        } catch (err) {
            this.stopServer();
            throw err;
        }
    }

    private stopServer(): void {
        if (!this.externalServer && this.serverProcess) {
            try {
                this.serverProcess.kill('SIGTERM');
                setTimeout(() => {
                    try { this.serverProcess?.kill('SIGKILL'); } catch {}
                }, 5000);
            } catch {}
            this.serverProcess = null;
        }
        if (!this.externalServer) {
            this.serverUrl = null;
            this.serverPort = null;
        }
        this.externalServer = false;
    }
}

async function readMimoConfigPort(): Promise<number | null> {
    try {
        const configPath = path.join(mimoHome(), 'config.yaml');
        const text = await fs.promises.readFile(configPath, 'utf-8');
        const m = text.match(/\bport[\s:=]+(\d+)/);
        if (m) return parseInt(m[1], 10);
    } catch { /* absent or unreadable */ }
    return null;
}

async function mimoAutoDetect(timeoutMs = 200): Promise<string | null> {
    const configPort = await readMimoConfigPort();
    const known = [3000, 7080, 8080, 8642, 9000];
    const ports = configPort
        ? [configPort, ...known.filter(p => p !== configPort)]
        : known;
    const results = await Promise.all(ports.map(async (port) => {
        const url = `http://127.0.0.1:${port}`;
        try {
            await jsonRequest(`${url}/global/health`, { timeoutMs });
            return url;
        } catch {
            return null;
        }
    }));
    return results.find((r) => r !== null) ?? null;
}
