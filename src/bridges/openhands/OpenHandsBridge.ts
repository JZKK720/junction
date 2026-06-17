import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, textRequest } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChoiceMenuItem, HistoryMessage, HistoryPart,
    ModelChoice, ToolStatusView, OPENCLAW_THINKING_LEVELS,
} from '../types';
import { Logger } from '../../utils/logger';
import { mapOpenHandsEvent } from './events';

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
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string; model?: string }>();
    private pollAbort = new Map<string, AbortController>();
    private skillCache = new Map<string, Array<{ name: string; description?: string }>>();

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string }]>>('junction.openhands.knownSessions');
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
    getSettingsQuery(): string { return 'junction.openhands'; }

    setPendingFileContext(context: string): void { this.pendingFileContext = context; }
    getPendingFileContext(): string | null { const c = this.pendingFileContext; this.pendingFileContext = null; return c; }

    // ── Sessions ───────────────────────────────────────────────────────────

    getCurrentSessionKey(_folderUri?: vscode.Uri): string | null { return this.activeSessionId; }
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> { return new Map(); }
    setActiveSession(_folderUri: vscode.Uri, key: string): void { this.activeSessionId = key; this.persistSessions(); }

    private incarnationSuffix(): string | undefined {
        try {
            const file = path.join(process.env.HOME || '~', 'entities', 'ling', 'workspace-灵', 'SOUL_INCARNATION.md');
            return require('fs').readFileSync(file, 'utf8').replace(/\{harness\}/g, 'OpenHands');
        } catch { return undefined; }
    }

    async createChat(_folderUri?: vscode.Uri): Promise<string> {
        const body: any = { agent_type: 'DEFAULT' };
        if (this.selection.modelId) body.llm_model = this.selection.modelId;
        const suffix = this.incarnationSuffix();
        if (suffix) body.system_message_suffix = suffix;
        try {
            const res: any = await jsonRequest(`${this.baseUrl}${API}/app-conversations`, { method: 'POST', body, timeoutMs: 120000 });
            const id = res?.conversation_id || res?.id || res?.conversation?.id;
            if (!id) throw new Error('no conversation id in start response');
            this.activeSessionId = String(id);
            this.knownSessions.set(this.activeSessionId, { title: res?.title || 'New chat', model: this.selection.modelId });
            this.persistSessions();
            return this.activeSessionId;
        } catch (err) {
            Logger.getInstance().error('openhands createChat failed', err);
            const id = `openhands-${Date.now()}`;
            this.activeSessionId = id;
            return id;
        }
    }

    async listSessions(): Promise<BridgeSession[]> {
        try {
            const res: any = await jsonRequest(`${this.baseUrl}${API}/app-conversations?limit=50`, { timeoutMs: 5000 });
            const items: any[] = res?.items || res?.results || res || [];
            return items.map((c) => {
                const key = String(c.conversation_id || c.id);
                this.knownSessions.set(key, { title: c.title || 'Conversation' });
                return { key, title: c.title || 'Conversation', lastActiveTs: Date.parse(c.updated_at || c.created_at || '') || undefined } as BridgeSession;
            });
        } catch {
            return Array.from(this.knownSessions.entries()).map(([key, v]) => ({ key, title: v.title }));
        }
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
            : await this.createChat();
        const runId = `openhands-${Date.now()}`;
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

                const mapped = mapOpenHandsEvent(runId, e);
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

    setSelection(selection: BridgeSelectionState): void { this.selection = selection; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        let models: any[] = [];
        try {
            const res: any = await jsonRequest(`${this.baseUrl}${API}/config/models/search?limit=100`, { timeoutMs: 5000 });
            models = res?.items || res?.results || res?.models || (Array.isArray(res) ? res : []);
        } catch (err) {
            Logger.getInstance().error('openhands listModelChoices failed', err);
            return [];
        }
        return models.map((m) => {
            const id = String(typeof m === 'string' ? m : (m.id || m.model || m.name));
            const slash = id.lastIndexOf('/');
            const provider = slash > 0 ? id.slice(0, slash) : (m.provider || '');
            const supportsReasoning = m.reasoning ?? m.supports_reasoning ?? true;
            const choice: ModelChoice = {
                id,
                label: slash > 0 ? id.slice(slash + 1) : id,
                description: provider,
                provider,
                model: id,
                supportsReasoning: !!supportsReasoning,
                icon: 'lightbulb',
                checked: selectedModel === id,
            };
            if (supportsReasoning) {
                choice.children = OPENCLAW_THINKING_LEVELS.map((level) => ({
                    id: `${id}:thinking:${level}`, label: level, icon: 'thinking', thinking: level,
                    checked: selectedThinking === level && selectedModel === id,
                }));
            }
            return choice;
        });
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const modelId = String(data.model ?? data.id ?? '').replace(/:thinking:.*$/, '');
        if (!modelId) return null;
        const thinking = data.thinking !== undefined ? String(data.thinking) : this.selection.thinking;
        this.setSelection({ ...this.selection, modelId, thinking });
        // Switch in-place if a real conversation is active.
        if (this.activeSessionId && !this.activeSessionId.startsWith('openhands-')) {
            jsonRequest(`${this.baseUrl}${API}/app-conversations/${encodeURIComponent(this.activeSessionId)}/switch-acp-model`, {
                method: 'POST', body: { model: modelId },
            }).catch(() => {});
        }
        const label = String(data.label ?? modelId.replace(/^.*\//, ''));
        return { display: label, modelId, thinking };
    }

    // ── Environment ─────────────────────────────────────────────────────────

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const connected = this.isConnected();
        return [{
            id: 'openhands:status',
            label: connected ? `Connected (${this.baseUrl})` : 'Not connected',
            description: connected ? 'OpenHands app server running' : 'Start the openhands server or set junction.openhands.serverUrl',
            icon: connected ? 'check' : 'warning',
            bridgeId: 'openhands',
        }, {
            id: 'openhands:configure',
            label: 'Configure OpenHands',
            description: 'Bridge settings',
            icon: 'gear',
            bridgeId: 'openhands',
        }];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        if (data.id === 'openhands:configure') vscode.commands.executeCommand('junction.openSettings');
    }

    getEnvironmentLabel(): string {
        const home = expandHome(ohConfig().get<string>('home') || '');
        return home ? path.basename(home) : 'OpenHands';
    }

    // ── Slash commands (microagents / skills) ──────────────────────────────

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
        const all = (id && this.skillCache.get(id)) || [];
        const p = prefix.replace(/^\//, '').toLowerCase();
        return all.filter((c) => !p || c.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null { return null; }
}
