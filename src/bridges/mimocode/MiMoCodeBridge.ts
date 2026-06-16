import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, streamSse } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem,
    ModelChoice, OPENCLAW_THINKING_LEVELS, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { mapMiMoCodeSseEvent, MiMoCodeMapperState } from './events';

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
    };

    private serverUrl: string | null = null;
    private serverPort: number | null = null;
    private serverProcess: ChildProcess | null = null;
    private externalServer = false;
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string; model?: string }>();
    private buffers = new Map<string, string>();
    private activeAbortController: AbortController | null = null;
    private sessionContextInjected = new Set<string>();
    private _mapperState: MiMoCodeMapperState = { reasoningParts: new Set(), textAccum: new Map() };
    private _lastUsage?: { inputTokens?: number; outputTokens?: number };

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        // Restore known sessions from workspaceState
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string }]>>(
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
        // Open VS Code settings for MiMoCode config
        await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'junction.mimocode',
        );
    }

    getSettingsQuery(): string {
        return 'junction.mimocode | junction.activeBridge';
    }

    // ── File context ───────────────────────────────────────────────────────

    setPendingFileContext(context: string): void {
        this.pendingFileContext = context;
    }

    getPendingFileContext(): string | null {
        const ctx = this.pendingFileContext;
        this.pendingFileContext = null;
        return ctx;
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

    async createChat(): Promise<string> {
        await this.ensureServer();
        const res = await jsonRequest<any>(`${this.serverUrl}/session`, {
            method: 'POST',
            body: {},
            timeoutMs: 15000,
        });
        const id = String(res?.id || res?.session?.id || '');
        if (!id) throw new Error('MiMoCode did not return session id');
        this.activeSessionId = id;
        this.knownSessions.set(id, {
            title: `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
            model: this.selection.modelId,
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
                const serverSessions = await jsonRequest<any[]>(`${this.serverUrl}/session`, { timeoutMs: 3000 });
                if (Array.isArray(serverSessions)) {
                    for (const s of serverSessions) {
                        if (s?.id && s?.title) {
                            const existing = this.knownSessions.get(s.id);
                            this.knownSessions.set(s.id, { title: s.title, model: existing?.model });
                        }
                    }
                    this.persistSessions();
                    // Set active to most recent if we have none or current is gone
                    if (serverSessions.length > 0 && (!this.activeSessionId || !serverSessions.some((s) => s.id === this.activeSessionId))) {
                        this.activeSessionId = serverSessions[0].id;
                        this.persistSessions();
                    }
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
                isCurrentGroup: true,
            }));
    }

    async renameSession(key: string, label: string): Promise<void> {
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
                `${this.serverUrl}/session/${encodeURIComponent(this.activeSessionId)}/message`,
                { timeoutMs: 10000 },
            );
            // MiMoCode returns [{ info: { role }, parts: [...] }] (flat array)
            const rawMessages = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
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
                            content.push({
                                type: 'toolCall',
                                name: part.tool || part.name || '',
                                toolCallId: part.callID || part.call_id || '',
                                arguments: part.input || part.args || {},
                            });
                        }
                    }
                    if (content.length > 0) {
                        messages.push({ role, content });
                    }
                }
            }
            return { messages };
        } catch (err) {
            Logger.getInstance().warn('Failed to fetch MiMoCode session history', err);
            return { messages: [] };
        }
    }

    // ── Messaging ──────────────────────────────────────────────────────────

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        await this.ensureServer();
        if (!this.activeSessionId) await this.createChat();
        const runId = this.activeSessionId!;
        const sessionKey = runId;
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
                `${this.serverUrl}/session/${encodeURIComponent(runId)}/message`,
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

    private subscribeEventStream(runId: string, sessionKey: string, signal: AbortSignal): Promise<void> {
        const state: MiMoCodeMapperState = { reasoningParts: new Set(), textAccum: new Map() };
        return streamSse(
            `${this.serverUrl}/event`,
            { method: 'GET', signal, timeoutMs: 0 },
            (event) => {
                const mapped = mapMiMoCodeSseEvent(runId, '', event.data, state);
                // Session-gate: skip events for other sessions
                let payload: any = {};
                try { payload = JSON.parse(event.data); } catch { return; }
                const props = payload.properties ?? {};
                if (props.sessionID && props.sessionID !== runId) return;

                if (mapped.usage) this._lastUsage = mapped.usage;
                for (const evt of mapped.events) {
                    this.emit('stream', { ...evt, sessionKey });
                }
            },
        ).catch(() => {});
    }

    async stopRun(): Promise<void> {
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
        }
        const sessionKey = this.activeSessionId;
        if (sessionKey) {
            // Best-effort server-side abort — ignore errors
            jsonRequest(`${this.serverUrl}/session/${encodeURIComponent(sessionKey)}/abort`, {
                method: 'POST',
                timeoutMs: 3000,
            }).catch(() => {});
            this.emit('stream', {
                type: 'agent_lifecycle',
                phase: 'cancelled',
                runId: sessionKey,
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

    async listModelChoices(
        selectedModel?: string,
        selectedThinking?: string,
    ): Promise<ModelChoice[]> {
        const models = [
            'mimo-auto',
            'anthropic/claude-opus-5',
            'anthropic/claude-sonnet-4.5',
            'openai/gpt-5.2',
            'openai/gpt-5.2-mini',
            'openai/o4-mini',
            'google/gemini-3-pro',
            'deepseek/deepseek-v4-pro',
            'deepseek/deepseek-v4-flash',
            'xiaomi/mimo-v2.5-pro',
        ];
        return models.map((id) => {
            const slash = id.indexOf('/');
            const provider = slash > 0 ? id.slice(0, slash) : '';
            const model = slash > 0 ? id.slice(slash + 1) : id;
            return {
                id,
                label: model,
                description: provider,
                provider,
                model,
                supportsReasoning: true,
                icon: 'lightbulb',
                checked: !selectedModel
                    ? id === 'anthropic/claude-opus-5'
                    : (selectedModel === id || selectedModel === model),
                children: OPENCLAW_THINKING_LEVELS.map((level) => ({
                    id: `${id}:thinking:${level}`,
                    label: level,
                    icon: 'thinking',
                    thinking: level,
                    checked: selectedThinking === level
                        && (selectedModel === id || selectedModel === model),
                })),
            };
        });
    }

    async selectModelChoice(data: any): Promise<{
        display: string;
        modelId: string;
        thinking?: string;
    } | null> {
        const provider = String(data.provider ?? '');
        const model = String(data.model ?? data.id ?? '').replace(/^.*:/, '');
        if (!model) return null;
        const modelId = provider ? `${provider}/${model}` : model;
        const thinking = data.thinking !== undefined
            ? String(data.thinking)
            : this.selection.thinking;
        this.setSelection({ modelId, thinking });
        if (this.activeSessionId) {
            const known = this.knownSessions.get(this.activeSessionId)
                ?? { title: this.activeSessionId };
            known.model = modelId;
            this.knownSessions.set(this.activeSessionId, known);
            this.persistSessions();
        }
        return { display: String(data.label ?? model), modelId, thinking };
    }

    // ── Environment / agent picker ─────────────────────────────────────────

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const available = this.isConnected();
        const configured = mimoServerUrl();
        const port = this.serverPort ? String(this.serverPort) : '?';
        if (!available) {
            const items: ChoiceMenuItem[] = [];
            if (!configured) {
                items.push({
                    id: 'mimocode:select-home',
                    label: 'Set path manually…',
                    description: 'Browse for the MiMoCode config directory',
                    section: 'MiMoCode',
                    icon: 'folder',
                    setup: true,
                });
            }
            items.push({
                id: 'mimocode:settings',
                label: 'Configure MiMoCode…',
                description: configured ? `External: ${configured}` : 'Bridge settings',
                section: 'MiMoCode',
                icon: 'gear',
                setup: true,
            });
            return items;
        }
        return [
            {
                id: 'mimocode:managed',
                label: configured ? `mimo@${new URL(configured).host}` : `ling@mimocode:${port}`,
                description: configured ? `External server at ${configured}` : 'Managed server running',
                section: 'MiMoCode',
                icon: 'hubot',
                checked: true,
            },
            {
                id: 'mimocode:settings',
                label: 'Configure MiMoCode…',
                description: 'Bridge settings',
                section: 'MiMoCode',
                icon: 'gear',
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
            return 'ling';
        }
        // Stripped prefix: ~/.mimocode-junction → junction
        const match = dirName.match(/^mimocode[_-]?(.+)/);
        return match ? match[1] : dirName;
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        return [
            { name: 'help', description: 'Show MiMoCode help' },
            { name: 'status', description: 'Show MiMoCode server status' },
            { name: 'config', description: 'Show MiMoCode bridge config' },
        ].filter((item) => item.name.startsWith(prefix));
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

    /** Returns true if the mapper signalled run completion (finish: stop/end). */
    private mapSse(runId: string, eventName: string, data: string): boolean {
        const mapped = mapMiMoCodeSseEvent(runId, eventName, data, this._mapperState);
        if (mapped.nextText !== undefined) {
            this.buffers.set(runId, mapped.nextText);
        }
        const sessionKey = runId;
        for (const event of mapped.events) {
            this.emit('stream', { ...event, sessionKey });
        }
        if (mapped.finished) {
            this.emit('stream', {
                type: 'agent_lifecycle',
                phase: 'completed',
                runId,
                sessionKey,
                usage: mapped.usage || { inputTokens: 0, outputTokens: 0 },
            });
        }
        return !!mapped.finished;
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
