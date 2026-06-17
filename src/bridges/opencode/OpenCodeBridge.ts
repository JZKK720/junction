import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, streamSse, textRequest } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChoiceMenuItem, HistoryMessage, HistoryPart,
    ModelChoice, ToolStatusView, OPENCLAW_THINKING_LEVELS,
} from '../types';
import { Logger } from '../../utils/logger';
import { mapOpenCodeEvent, eventSessionId, newOpenCodeMapperState, OpenCodeMapperState } from './events';

function ocConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.opencode');
}

function expandHome(raw: string): string {
    if (!raw) return raw;
    if (raw === '~' || raw === '~/') return process.env.HOME || raw;
    if (raw.startsWith('~/')) return path.join(process.env.HOME || '~', raw.slice(2));
    return raw;
}

function ocBinaryPath(): string {
    const configured = ocConfig().get<string>('binaryPath');
    if (configured) return expandHome(configured);
    const home = process.env.HOME || '~';
    const local = path.join(home, 'bin', 'opencode');
    try { require('fs').accessSync(local); return local; } catch {}
    return 'opencode';
}

function ocServerUrl(): string {
    return (ocConfig().get<string>('serverUrl') || '').trim();
}

function pickPort(): number {
    const configured = ocConfig().get<number>('port') || 0;
    if (configured > 0) return configured;
    return 40000 + Math.floor(Math.random() * 20000);
}

export class OpenCodeBridge extends EventEmitter implements ChatBridge {
    readonly id = 'opencode';
    readonly label = 'opencode';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: true,
        steering: true,
        usage: false,
        tools: true,
    };

    private process: ChildProcess | null = null;
    private baseUrl = '';
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string; model?: string }>();
    private mapperStates = new Map<string, OpenCodeMapperState>();
    private runBySession = new Map<string, string>();
    private eventAbort: AbortController | null = null;
    private commandCache: Array<{ name: string; description?: string }> = [];

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string }]>>('junction.opencode.knownSessions');
        if (saved) this.knownSessions = new Map(saved);
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.opencode.activeSessionId', null);
    }

    private persistSessions(): void {
        this.context.workspaceState.update('junction.opencode.knownSessions', Array.from(this.knownSessions.entries()));
        this.context.workspaceState.update('junction.opencode.activeSessionId', this.activeSessionId);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    async connect(): Promise<boolean> {
        if (this.isConnected()) return true;

        const explicit = ocServerUrl();
        if (explicit) {
            this.baseUrl = explicit.replace(/\/$/, '');
            if (!await this.ping()) { this.baseUrl = ''; this.emit('disconnected'); return false; }
        } else if (!await this.spawnServer()) {
            this.emit('disconnected');
            return false;
        }

        this.startEventStream();
        this.loadCommands().catch(() => {});
        this.emit('connected');
        return true;
    }

    private async ping(): Promise<boolean> {
        try { await textRequest(`${this.baseUrl}/provider`, { timeoutMs: 800 }); return true; } catch { return false; }
    }

    private async spawnServer(): Promise<boolean> {
        const port = pickPort();
        const url = `http://127.0.0.1:${port}`;
        const bin = ocBinaryPath();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME;
        const env = { ...process.env };
        const home = expandHome(ocConfig().get<string>('home') || '');
        if (home) env.OPENCODE_CONFIG = path.join(home, 'opencode.json');

        try {
            this.process = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd, env });
        } catch (err) {
            Logger.getInstance().error('opencode spawn failed', err);
            return false;
        }
        this.process.on('exit', () => { this.process = null; this.baseUrl = ''; this.emit('disconnected'); });

        // Poll until the HTTP server answers.
        for (let i = 0; i < 60; i++) {
            try { await textRequest(`${url}/provider`, { timeoutMs: 500 }); this.baseUrl = url; return true; } catch {}
            await new Promise((r) => setTimeout(r, 250));
        }
        Logger.getInstance().error('opencode server did not come up on ' + url);
        if (this.process) { this.process.kill(); this.process = null; }
        return false;
    }

    private startEventStream(): void {
        if (this.eventAbort) return;
        this.eventAbort = new AbortController();
        const run = () => {
            if (!this.baseUrl || !this.eventAbort) return;
            streamSse(`${this.baseUrl}/event`, { method: 'GET', timeoutMs: 0, signal: this.eventAbort.signal }, (ev) => {
                let payload: any;
                try { payload = JSON.parse(ev.data); } catch { return; }
                this.routeEvent(payload);
            }).then(() => {
                // Stream ended; reconnect while still connected.
                if (this.baseUrl && this.eventAbort && !this.eventAbort.signal.aborted) setTimeout(run, 500);
            }).catch(() => {
                if (this.baseUrl && this.eventAbort && !this.eventAbort.signal.aborted) setTimeout(run, 1000);
            });
        };
        run();
    }

    private routeEvent(payload: any): void {
        const sessionId = eventSessionId(payload);
        if (!sessionId) return;
        const runId = this.runBySession.get(sessionId);
        if (!runId) return;
        let state = this.mapperStates.get(sessionId);
        if (!state) { state = newOpenCodeMapperState(); this.mapperStates.set(sessionId, state); }
        const result = mapOpenCodeEvent(runId, payload, state);
        for (const e of result.events) this.emit('stream', { ...e, sessionKey: sessionId });
        if (result.finished) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey: sessionId });
            this.runBySession.delete(sessionId);
            this.mapperStates.delete(sessionId);
        }
    }

    disconnect(): void {
        if (this.eventAbort) { this.eventAbort.abort(); this.eventAbort = null; }
        if (this.process) { this.process.kill(); this.process = null; }
        this.baseUrl = '';
        this.runBySession.clear();
        this.mapperStates.clear();
        this.emit('disconnected');
    }

    isConnected(): boolean { return !!this.baseUrl; }

    async initializeWorkspace(): Promise<void> {}
    async registerRuntimeIntegrations(): Promise<void> {}
    async configure(): Promise<void> { vscode.commands.executeCommand('junction.openSettings'); }
    getSettingsQuery(): string { return 'junction.opencode'; }

    setPendingFileContext(context: string): void { this.pendingFileContext = context; }
    getPendingFileContext(): string | null { const c = this.pendingFileContext; this.pendingFileContext = null; return c; }

    // ── Sessions ───────────────────────────────────────────────────────────

    getCurrentSessionKey(_folderUri?: vscode.Uri): string | null { return this.activeSessionId; }
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> { return new Map(); }
    setActiveSession(_folderUri: vscode.Uri, key: string): void { this.activeSessionId = key; this.persistSessions(); }

    async createChat(_folderUri?: vscode.Uri): Promise<string> {
        try {
            const res: any = await jsonRequest(`${this.baseUrl}/session`, { method: 'POST', body: {} });
            const id = res?.id || `opencode-${Date.now()}`;
            this.activeSessionId = id;
            this.knownSessions.set(id, { title: res?.title || 'New chat' });
            this.persistSessions();
            return id;
        } catch (err) {
            Logger.getInstance().error('opencode createChat failed', err);
            const id = `opencode-${Date.now()}`;
            this.activeSessionId = id;
            return id;
        }
    }

    async forkChat(parentSessionKey: string, _folderUri?: vscode.Uri): Promise<string | null> {
        try {
            const res: any = await jsonRequest(`${this.baseUrl}/session/${encodeURIComponent(parentSessionKey)}/fork`, { method: 'POST', body: {} });
            const id = res?.id;
            if (!id) return null;
            this.knownSessions.set(id, { title: res?.title || 'Fork' });
            this.persistSessions();
            return id;
        } catch (err) {
            Logger.getInstance().error('opencode forkChat failed', err);
            return null;
        }
    }

    async listSessions(): Promise<BridgeSession[]> {
        try {
            const list: any[] = await jsonRequest(`${this.baseUrl}/session`, { timeoutMs: 4000 }) || [];
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
            return list.map((s) => {
                this.knownSessions.set(s.id, { title: s.title || 'Session' });
                return {
                    key: s.id,
                    title: s.title || 'Session',
                    lastActiveTs: s.time?.updated || s.time?.created,
                    folderUri: folder,
                } as BridgeSession;
            });
        } catch {
            return Array.from(this.knownSessions.entries()).map(([key, v]) => ({ key, title: v.title }));
        }
    }

    async renameSession(key: string, label: string): Promise<void> {
        try { await jsonRequest(`${this.baseUrl}/session/${encodeURIComponent(key)}`, { method: 'PATCH', body: { title: label } }); } catch {}
        const e = this.knownSessions.get(key); if (e) { e.title = label; this.persistSessions(); }
    }

    async getSessionHistory(limit = 200, _folderUri?: vscode.Uri): Promise<HistoryMessage[]> {
        const sessionId = this.activeSessionId;
        if (!sessionId) return [];
        try {
            const rows: any[] = await jsonRequest(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`, { timeoutMs: 8000 }) || [];
            const out: HistoryMessage[] = [];
            for (const row of rows) {
                const info = row.info || row;
                const parts: any[] = row.parts || [];
                if (info.role === 'user') {
                    const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('');
                    out.push({ role: 'user', content: text });
                } else {
                    const content: HistoryPart[] = [];
                    for (const p of parts) {
                        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
                        else if (p.type === 'reasoning' && p.text) content.push({ type: 'reasoning', text: p.text });
                        else if (p.type === 'tool') content.push({
                            type: 'toolCall', toolName: p.tool, toolCallId: p.callID,
                            input: p.state?.input, text: typeof p.state?.output === 'string' ? p.state.output : undefined,
                        });
                    }
                    out.push({ role: 'assistant', content });
                }
            }
            return out;
        } catch (err) {
            Logger.getInstance().error('opencode getSessionHistory failed', err);
            return [];
        }
    }

    // ── Send / stop / steer ─────────────────────────────────────────────────

    async sendChatMessage(message: string, _context?: BridgeContext): Promise<any> {
        const sessionId = this.activeSessionId || await this.createChat();
        const runId = `opencode-${Date.now()}`;
        this.runBySession.set(sessionId, runId);
        this.mapperStates.set(sessionId, newOpenCodeMapperState());
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: sessionId });

        const body: any = { parts: [{ type: 'text', text: message }] };
        const model = this.modelParts();
        if (model) body.model = model;

        // Fire the prompt; streaming + completion arrive on the global /event stream.
        jsonRequest(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`, { method: 'POST', body, timeoutMs: 600000 })
            .catch((err) => {
                Logger.getInstance().error('opencode prompt failed', err);
                if (this.runBySession.get(sessionId) === runId) {
                    this.emit('stream', { type: 'agent_message', runId, text: `Error: ${err.message || err}`, sessionKey: sessionId });
                    this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey: sessionId });
                    this.runBySession.delete(sessionId);
                }
            });

        return { runId, sessionKey: sessionId };
    }

    private modelParts(): { providerID: string; modelID: string } | null {
        const id = this.selection.modelId;
        if (!id) return null;
        const slash = id.indexOf('/');
        if (slash <= 0) return null;
        return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
    }

    async stopRun(sessionKey?: string, _runId?: string): Promise<void> {
        const id = sessionKey || this.activeSessionId;
        if (!id) return;
        try { await jsonRequest(`${this.baseUrl}/session/${encodeURIComponent(id)}/abort`, { method: 'POST', body: {} }); } catch {}
        this.runBySession.delete(id);
    }

    async getUsage(): Promise<any> { return null; }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        // opencode accepts a follow-up prompt on a busy session (queued/steered server-side).
        try {
            await jsonRequest(`${this.baseUrl}/session/${encodeURIComponent(sessionKey)}/message`, { method: 'POST', body: { parts: [{ type: 'text', text: message }] }, timeoutMs: 600000 });
            return true;
        } catch { return false; }
    }

    canSteer(): boolean { return true; }
    canAdminInject(): boolean { return false; }

    // ── Models ────────────────────────────────────────────────────────────

    setSelection(selection: BridgeSelectionState): void { this.selection = selection; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        let providers: any[] = [];
        try {
            const res: any = await jsonRequest(`${this.baseUrl}/provider`, { timeoutMs: 4000 });
            providers = res?.all || res?.providers || [];
        } catch (err) {
            Logger.getInstance().error('opencode listModelChoices failed', err);
            return [];
        }
        const choices: ModelChoice[] = [];
        for (const provider of providers) {
            const models = provider.models || {};
            for (const key of Object.keys(models)) {
                const m = models[key];
                const id = `${provider.id}/${m.id || key}`;
                const reasoning = !!m.reasoning;
                const choice: ModelChoice = {
                    id,
                    label: m.name || m.id || key,
                    description: provider.name || provider.id,
                    provider: provider.id,
                    model: m.id || key,
                    supportsReasoning: reasoning,
                    icon: 'lightbulb',
                    checked: selectedModel === id,
                };
                if (reasoning) {
                    choice.children = OPENCLAW_THINKING_LEVELS.map((level) => ({
                        id: `${id}:thinking:${level}`,
                        label: level,
                        icon: 'thinking',
                        thinking: level,
                        checked: selectedThinking === level && selectedModel === id,
                    }));
                }
                choices.push(choice);
            }
        }
        return choices;
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const provider = String(data.provider ?? '');
        const model = String(data.model ?? data.id ?? '').replace(/:thinking:.*$/, '').replace(/^.*\//, '');
        if (!model) return null;
        const modelId = provider ? `${provider}/${model}` : String(data.id ?? model).replace(/:thinking:.*$/, '');
        const thinking = data.thinking !== undefined ? String(data.thinking) : this.selection.thinking;
        this.setSelection({ ...this.selection, modelId, thinking });
        return { display: String(data.label ?? model), modelId, thinking };
    }

    // ── Environment ─────────────────────────────────────────────────────────

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const connected = this.isConnected();
        return [{
            id: 'opencode:status',
            label: connected ? `Connected (${this.baseUrl})` : 'Not connected',
            description: connected ? 'opencode server running' : 'Set junction.opencode.serverUrl or install opencode',
            icon: connected ? 'check' : 'warning',
            bridgeId: 'opencode',
        }, {
            id: 'opencode:configure',
            label: 'Configure opencode',
            description: 'Bridge settings',
            icon: 'gear',
            bridgeId: 'opencode',
        }];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        if (data.id === 'opencode:configure') vscode.commands.executeCommand('junction.openSettings');
    }

    getEnvironmentLabel(): string {
        const home = expandHome(ocConfig().get<string>('home') || '');
        return home ? path.basename(home) : 'opencode';
    }

    // ── Slash commands ───────────────────────────────────────────────────────

    private async loadCommands(): Promise<void> {
        try {
            const list: any[] = await jsonRequest(`${this.baseUrl}/command`, { timeoutMs: 3000 }) || [];
            this.commandCache = list.map((c) => ({ name: c.name, description: c.description }));
        } catch { /* leave cache */ }
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const p = prefix.replace(/^\//, '').toLowerCase();
        return this.commandCache.filter((c) => !p || c.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null { return null; }
}
