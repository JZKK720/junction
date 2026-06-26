import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, textRequest } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, HistoryMessage, HistoryPart,
    ModelChoice, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';
import { mapOpenHandsEvent } from './events';
import { listOpenHandsModelChoices, selectOpenHandsModelChoice } from './modelPicker';
import { bindSessionWorkspace, boundWorkspaceUri, decorateSessionsWithWorkspaceBindings } from '../sessionBindings';
import { buildKeyValueCommandOutput, buildTableCommandOutput, commandOutputToMarkdown } from '../commandOutput';
import { parseSlashCommand, slashRunId } from '../slashCommands';

const API = '/api/v1';

function ohConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.openhands');
}

function expandHome(raw: string): string {
    if (!raw) return raw;
    if (raw === '~' || raw === '~/') return process.env.HOME || raw;
    if (raw.startsWith('~/')) return path.join(process.env.HOME || '~', raw.slice(2));
    return raw;
}

function ohServerUrl(): string {
    return (ohConfig().get<string>('serverUrl') || 'http://127.0.0.1:3000').trim().replace(/\/$/, '');
}

function ohBinaryPath(): string {
    const configured = ohConfig().get<string>('binaryPath');
    if (configured) return expandHome(configured);
    return path.join(process.env.HOME || '~', 'bin', 'openhands');
}

export class OpenHandsBridge extends EventEmitter implements ChatBridge {
    readonly id = 'openhands';
    readonly label = 'OpenHands';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: false,
        steering: true,
        usage: false,
        tools: true,
    };

    private process: ChildProcess | null = null;
    private baseUrl = '';
    private activeSessionId: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string; model?: string; workspaceUri?: string; workspaceName?: string }>();
    private pollAbort = new Map<string, AbortController>();
    private skillCache = new Map<string, Array<{ name: string; description?: string }>>();

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string; workspaceUri?: string; workspaceName?: string }]>>('junction.openhands.knownSessions');
        if (saved) this.knownSessions = new Map(saved);
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.openhands.activeSessionId', null);
    }

    private persistSessions(): void {
        this.context.workspaceState.update('junction.openhands.knownSessions', Array.from(this.knownSessions.entries()));
        this.context.workspaceState.update('junction.openhands.activeSessionId', this.activeSessionId);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    async connect(): Promise<boolean> {
        if (this.isConnected()) return true;
        const url = ohServerUrl();
        if (await this.ping(url)) { this.baseUrl = url; this.emit('connected'); return true; }
        if (await this.spawnServer(url)) { this.emit('connected'); return true; }
        this.emit('disconnected');
        return false;
    }

    private async ping(url: string): Promise<boolean> {
        try { await textRequest(`${url}${API}/config/models/search?limit=1`, { timeoutMs: 800 }); return true; } catch { return false; }
    }

    private async spawnServer(url: string): Promise<boolean> {
        const bin = ohBinaryPath();
        try { require('fs').accessSync(bin); } catch { Logger.getInstance().error('openhands binary not found: ' + bin); return false; }
        const env = { ...process.env };
        const home = expandHome(ohConfig().get<string>('home') || '');
        if (home) env.OPENHANDS_HOME = home;
        try {
            this.process = spawn(bin, [], { cwd: expandHome(ohConfig().get<string>('repoPath') || '') || undefined, env });
        } catch (err) {
            Logger.getInstance().error('openhands spawn failed', err);
            return false;
        }
        this.process.on('exit', () => { this.process = null; this.baseUrl = ''; this.emit('disconnected'); });
        for (let i = 0; i < 80; i++) {
            if (await this.ping(url)) { this.baseUrl = url; return true; }
            await new Promise((r) => setTimeout(r, 500));
        }
        Logger.getInstance().error('openhands server did not come up on ' + url);
        if (this.process) { this.process.kill(); this.process = null; }
        return false;
    }

    disconnect(): void {
        for (const ac of this.pollAbort.values()) ac.abort();
        this.pollAbort.clear();
        if (this.process) { this.process.kill(); this.process = null; }
        this.baseUrl = '';
        this.emit('disconnected');
    }

    isConnected(): boolean { return !!this.baseUrl; }

    async initializeWorkspace(): Promise<void> {}
    async registerRuntimeIntegrations(): Promise<void> {}
    async configure(): Promise<void> { vscode.commands.executeCommand('junction.openSettings'); }

    // ── Sessions ───────────────────────────────────────────────────────────

    getCurrentSessionKey(_folderUri?: vscode.Uri): string | null { return this.activeSessionId; }
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> { return new Map(); }
    setActiveSession(_folderUri: vscode.Uri, key: string): void { this.activeSessionId = key; this.persistSessions(); }
    bindSessionWorkspace(sessionKey: string | null | undefined, folderUri?: vscode.Uri): void {
        bindSessionWorkspace(this.context, this.id, sessionKey, folderUri);
    }
    boundSessionWorkspace(sessionKey: string | null | undefined): vscode.Uri | undefined {
        return boundWorkspaceUri(this.context, this.id, sessionKey);
    }

    private incarnationSuffix(): string | undefined {
        try {
            const file = path.join(process.env.HOME || '~', 'entities', 'ling', 'workspace-灵', 'SOUL_INCARNATION.md');
            return require('fs').readFileSync(file, 'utf8').replace(/\{harness\}/g, 'OpenHands');
        } catch { return undefined; }
    }

    async createChat(folderUri?: vscode.Uri): Promise<string> {
        const body: any = { agent_type: 'DEFAULT' };
        if (this.selection.modelId) body.llm_model = this.selection.modelId;
        const suffix = this.incarnationSuffix();
        if (suffix) body.system_message_suffix = suffix;
        try {
            const res: any = await jsonRequest(`${this.baseUrl}${API}/app-conversations`, { method: 'POST', body, timeoutMs: 120000 });
            const id = res?.conversation_id || res?.id || res?.conversation?.id;
            if (!id) throw new Error('no conversation id in start response');
            this.activeSessionId = String(id);
            const folder = folderUri || vscode.workspace.workspaceFolders?.[0]?.uri;
            this.knownSessions.set(this.activeSessionId, {
                title: res?.title || 'New chat',
                model: this.selection.modelId,
                workspaceUri: folder?.toString(),
                workspaceName: folder ? (vscode.workspace.getWorkspaceFolder(folder)?.name || path.basename(folder.fsPath)) : undefined,
            });
            this.bindSessionWorkspace(this.activeSessionId, folder);
            this.persistSessions();
            return this.activeSessionId;
        } catch (err) {
            Logger.getInstance().error('openhands createChat failed', err);
            const id = `openhands-${Date.now()}`;
            this.activeSessionId = id;
            return id;
        }
    }

    async listSessions(scope: ChatScope = 'all', includeArchived = false, archivedKeys: ReadonlySet<string> = new Set()): Promise<BridgeSession[]> {
        try {
            const res: any = await jsonRequest(`${this.baseUrl}${API}/app-conversations?limit=50`, { timeoutMs: 5000 });
            const items: any[] = res?.items || res?.results || res || [];
            const sessions = items.map((c) => {
                const key = String(c.conversation_id || c.id);
                const known = this.knownSessions.get(key);
                this.knownSessions.set(key, { ...known, title: c.title || known?.title || 'Conversation' });
                return {
                    key,
                    title: c.title || known?.title || 'Conversation',
                    model: known?.model,
                    isActive: key === this.activeSessionId,
                    isArchived: archivedKeys.has(key),
                    workspaceUri: known?.workspaceUri,
                    workspaceName: known?.workspaceName,
                    lastActiveTs: Date.parse(c.updated_at || c.created_at || '') || undefined,
                } as BridgeSession;
            });
            const filtered = includeArchived ? sessions : sessions.filter((s) => !s.isArchived);
            return decorateSessionsWithWorkspaceBindings(this.context, this.id, filtered, scope, vscode.workspace.workspaceFolders?.[0]?.uri, false);
        } catch {
            const sessions = Array.from(this.knownSessions.entries()).map(([key, v]) => ({ key, title: v.title, model: v.model, workspaceUri: v.workspaceUri, workspaceName: v.workspaceName, isArchived: archivedKeys.has(key) }));
            const filtered = includeArchived ? sessions : sessions.filter((s) => !s.isArchived);
            return decorateSessionsWithWorkspaceBindings(this.context, this.id, filtered, scope, vscode.workspace.workspaceFolders?.[0]?.uri, false);
        }
    }

    async listWorkspaceSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>, currentFolder?: vscode.Uri): Promise<BridgeSession[]> {
        const sessions = await this.listSessions(scope, includeArchived, archivedKeys);
        return decorateSessionsWithWorkspaceBindings(this.context, this.id, sessions, scope, currentFolder, false);
    }

    async renameSession(key: string, label: string): Promise<void> {
        try { await jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(key)}`, { method: 'PATCH', body: { title: label } }); } catch {}
        const e = this.knownSessions.get(key); if (e) { e.title = label; this.persistSessions(); }
    }

    private async fetchEvents(sessionId: string, sinceIso?: string): Promise<any[]> {
        let url = `${this.baseUrl}${API}/conversation/${encodeURIComponent(sessionId)}/events/search?sort_order=TIMESTAMP&limit=100`;
        if (sinceIso) url += `&timestamp__gte=${encodeURIComponent(sinceIso)}`;
        const res: any = await jsonRequest(url, { timeoutMs: 8000 });
        return res?.items || res?.events || (Array.isArray(res) ? res : []);
    }

    async getSessionHistory(_limit = 200, _folderUri?: vscode.Uri): Promise<HistoryMessage[]> {
        const sessionId = this.activeSessionId;
        if (!sessionId || sessionId.startsWith('openhands-')) return [];
        try {
            const events = await this.fetchEvents(sessionId);
            captureBridgeHistoryDebug(this.id, 'history-native', {
                operation: 'getSessionHistory.events',
                sessionKey: sessionId,
                inputCount: events.length,
                inputMessages: events,
            });
            const out: HistoryMessage[] = [];
            for (const e of events) {
                const mapped = mapOpenHandsEvent('history', e);
                const role = String(e.llm_message?.role || e.source || '').toLowerCase();
                if (role === 'user') {
                    const text = String(e.content?.[0]?.text ?? e.content ?? e.message ?? '');
                    if (text) out.push({ role: 'user', content: text });
                    continue;
                }
                const parts: HistoryPart[] = [];
                if (mapped.thinking) parts.push({ type: 'reasoning', text: mapped.thinking });
                if (mapped.assistantText) parts.push({ type: 'text', text: mapped.assistantText });
                for (const t of mapped.tools) {
                    if (t.phase === 'start') parts.push({ type: 'toolCall', toolName: String(t.toolName || ''), toolCallId: String(t.toolCallId || ''), input: t.args });
                }
                if (parts.length) out.push({ role: 'assistant', content: parts });
            }
            captureBridgeHistoryDebug(this.id, 'history-normalized', {
                operation: 'getSessionHistory.events',
                sessionKey: sessionId,
                outputCount: out.length,
                outputMessages: out,
            });
            return out;
        } catch (err) {
            Logger.getInstance().error('openhands getSessionHistory failed', err);
            return [];
        }
    }

    // ── Send + poll ──────────────────────────────────────────────────────────

    async sendChatMessage(message: string, _context?: BridgeContext): Promise<any> {
        const sessionId = (this.activeSessionId && !this.activeSessionId.startsWith('openhands-'))
            ? this.activeSessionId
            : await this.createChat(_context?.workspaceFolder ? vscode.Uri.file(_context.workspaceFolder) : undefined);
        const runId = `openhands-${Date.now()}`;
        captureBridgeDebug(this.id, 'request', {
            operation: 'sendChatMessage',
            sessionKey: sessionId,
            runId,
            message,
            context: _context,
        });
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: sessionId });

        try {
            await jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(sessionId)}/send-message`, {
                method: 'POST',
                body: { role: 'user', content: [{ type: 'text', text: message }], run: true },
                timeoutMs: 120000,
            });
        } catch (err: any) {
            Logger.getInstance().error('openhands send-message failed', err);
            this.emit('stream', { type: 'agent_message', runId, text: `Error: ${err.message || err}`, sessionKey: sessionId });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey: sessionId });
            return { runId, sessionKey: sessionId };
        }

        this.pollEvents(sessionId, runId).catch((err) => Logger.getInstance().error('openhands poll failed', err));
        return { runId, sessionKey: sessionId };
    }

    private async pollEvents(sessionId: string, runId: string): Promise<void> {
        const ac = new AbortController();
        this.pollAbort.get(sessionId)?.abort();
        this.pollAbort.set(sessionId, ac);

        const seen = new Set<string>();
        let accum = '';
        let sinceIso = new Date(Date.now() - 2000).toISOString();
        let emptyPolls = 0;
        const started = Date.now();

        while (!ac.signal.aborted) {
            if (Date.now() - started > 600000) break;
            let events: any[] = [];
            try { events = await this.fetchEvents(sessionId, sinceIso); } catch { /* transient */ }

            let newCount = 0;
            let finished = false;
            for (const e of events) {
                const eid = String(e.id || e.event_id || `${e.timestamp || ''}:${e.kind || ''}`);
                if (seen.has(eid)) continue;
                seen.add(eid);
                newCount++;
                const ts = e.timestamp || e.created_at || e.time;
                if (ts && typeof ts === 'string' && ts > sinceIso) sinceIso = ts;

                captureBridgeDebug(this.id, 'native', {
                    operation: 'pollEvents.fetch',
                    sessionKey: sessionId,
                    runId,
                    event: e,
                });
                const mapped = mapOpenHandsEvent(runId, e);
                captureBridgeDebug(this.id, 'normalized', {
                    operation: 'pollEvents.map',
                    sessionKey: sessionId,
                    runId,
                    eventId: eid,
                    mapped,
                });
                if (mapped.thinking) this.emit('stream', { type: 'thinking_chunk', runId, text: mapped.thinking, sessionKey: sessionId });
                for (const t of mapped.tools) this.emit('stream', { ...t, sessionKey: sessionId });
                if (mapped.assistantText) {
                    accum = accum ? `${accum}\n\n${mapped.assistantText}` : mapped.assistantText;
                    this.emit('stream', { type: 'agent_message', runId, text: accum, sessionKey: sessionId });
                }
                if (mapped.finished) finished = true;
            }

            if (finished) break;
            emptyPolls = newCount ? 0 : emptyPolls + 1;
            if (accum && emptyPolls >= 30) break; // ~30s quiet after producing output
            await new Promise((r) => setTimeout(r, 1000));
        }

        this.pollAbort.delete(sessionId);
        if (!ac.signal.aborted) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey: sessionId });
        }
    }

    async stopRun(sessionKey?: string, _runId?: string): Promise<void> {
        const id = sessionKey || this.activeSessionId;
        if (!id) return;
        this.pollAbort.get(id)?.abort();
        this.pollAbort.delete(id);
        try { await jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }); } catch {}
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: _runId || `openhands-stop-${Date.now()}`, sessionKey: id });
    }

    async getUsage(): Promise<any> { return null; }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        try {
            await jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(sessionKey)}/send-message`, {
                method: 'POST', body: { role: 'user', content: [{ type: 'text', text: message }], run: true }, timeoutMs: 120000,
            });
            return true;
        } catch { return false; }
    }

    canSteer(): boolean { return true; }
    canAdminInject(): boolean { return false; }

    // ── Models ────────────────────────────────────────────────────────────

    setSelection(selection: BridgeSelectionState): void { this.selection = { ...this.selection, ...selection }; }

    getSelection(): BridgeSelectionState { return { ...this.selection }; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        return listOpenHandsModelChoices(this.baseUrl, API, selectedModel, selectedThinking);
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const selected = selectOpenHandsModelChoice(data, this.selection);
        if (!selected) return null;
        const { modelId, thinking } = selected;
        this.setSelection({ ...this.selection, modelId, thinking });
        // Switch in-place if a real conversation is active.
        if (this.activeSessionId && !this.activeSessionId.startsWith('openhands-')) {
            jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(this.activeSessionId)}/switch-acp-model`, {
                method: 'POST', body: { model: modelId },
            }).catch(() => {});
        }
        return selected;
    }

    // ── Environment ─────────────────────────────────────────────────────────

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const connected = this.isConnected();
        return [{
            id: 'openhands:status',
            label: connected ? `Connected (${this.baseUrl})` : 'Not connected',
            description: connected ? 'OpenHands app server running' : 'Start the openhands server or set junction.openhands.serverUrl',
            icon: connected ? 'check' : 'warning',
            setup: !connected,
            bridgeId: 'openhands',
        }, {
            id: 'openhands:configure',
            label: 'Configure OpenHands',
            description: 'Bridge settings',
            icon: 'gear',
            setup: true,
            bridgeId: 'openhands',
        }];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        if (data.id === 'openhands:configure') vscode.commands.executeCommand('junction.openSettings');
    }

    getEnvironmentLabel(): string {
        const home = expandHome(ohConfig().get<string>('home') || '');
        return home ? path.basename(home) : 'OpenHands@openhands';
    }

    // ── Slash commands (microagents / skills) ──────────────────────────────

    async executeSlashCommand(command: string, context?: BridgeContext): Promise<any> {
        const parsed = parseSlashCommand(command);
        if (!parsed) return this.sendChatMessage(command, context);
        if (parsed.name === 'status' || parsed.name === 'models' || parsed.name === 'skills') {
            if (!this.activeSessionId) await this.createChat(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined);
            const runId = slashRunId(this.id, parsed.name);
            const sessionKey = this.activeSessionId!;
            captureBridgeDebug(this.id, 'request', {
                operation: 'executeSlashCommand',
                sessionKey,
                runId,
                command,
                parsed,
                context,
            });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });
            const commandOutput = await this.nativeSlash(parsed.name, sessionKey);
            this.emit('stream', { type: 'agent_message', runId, sessionKey, text: commandOutputToMarkdown(commandOutput), commandOutput });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey });
            return { runId, sessionKey };
        }
        return this.sendChatMessage(command, context);
    }

    private async nativeSlash(name: string, sessionId: string) {
        if (name === 'status') {
            return buildKeyValueCommandOutput('/status', [
                { key: 'server', value: this.baseUrl || 'not connected' },
                { key: 'session', value: sessionId || 'none' },
                { key: 'model', value: this.selection.modelId || 'default' },
            ], 'OpenHands status');
        }
        if (name === 'models') {
            const models = await this.listModelChoices(this.selection.modelId, this.selection.thinking);
            const rows: string[][] = [];
            for (const provider of models) {
                for (const child of provider.children || []) rows.push([String(provider.label || provider.id), String(child.model || child.id), child.checked ? 'yes' : '']);
            }
            return buildTableCommandOutput('/models', ['Provider', 'Model', 'Selected'], rows, 'OpenHands models');
        }
        await this.loadSkills(sessionId);
        const skills = this.skillCache.get(sessionId) || [];
        return buildTableCommandOutput('/skills', ['Skill', 'Description'], skills.map((s) => [s.name, s.description || '']), 'OpenHands skills');
    }

    private async loadSkills(sessionId: string): Promise<void> {
        if (this.skillCache.has(sessionId)) return;
        try {
            const res: any = await jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(sessionId)}/skills`, { timeoutMs: 4000 });
            const items: any[] = res?.items || res?.skills || (Array.isArray(res) ? res : []);
            this.skillCache.set(sessionId, items.map((s) => ({ name: String(s.name || s.trigger || s), description: s.description })));
        } catch { this.skillCache.set(sessionId, []); }
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const id = this.activeSessionId;
        if (id && !id.startsWith('openhands-')) this.loadSkills(id).catch(() => {});
        const all = [
            { name: 'status', description: 'Show OpenHands bridge status' },
            { name: 'models', description: 'Show OpenHands model choices' },
            { name: 'skills', description: 'Show OpenHands skills/microagents' },
            ...((id && this.skillCache.get(id)) || []),
        ];
        const p = prefix.replace(/^\//, '').toLowerCase();
        return all.filter((c) => !p || c.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null { return null; }
}
