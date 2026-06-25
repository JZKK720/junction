import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, streamSse, textRequest } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, HistoryMessage, HistoryPart,
    ModelChoice, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';
import { mapOpenCodeEvent, eventSessionId, newOpenCodeMapperState, OpenCodeMapperState } from './events';
import { listOpenCodeModelChoices, organizeOpenCodeModelChoices, selectOpenCodeModelChoice } from './modelPicker';
import { parseSlashCommand } from '../slashCommands';
import { bindSessionWorkspace, boundWorkspaceUri, decorateSessionsWithWorkspaceBindings } from '../sessionBindings';

type KnownOpenCodeSession = { title: string; model?: string; workspaceUri?: string; workspaceName?: string };
type OpenCodeSessionModelRef = { providerID: string; id: string };
/** Per-CLI-run accumulator: route per-step narration vs final reply, build history record. */
type RunAccumulator = {
    /** messageID -> latest text snapshot for that step (resolved at its step_finish). */
    stepText: Map<string, string>;
    /** Final-step texts, joined into the reply bubble. */
    replyParts: string[];
    /** Step messageIDs already emitted as interleaved narration notes. */
    emittedNotes: Set<string>;
    parts: HistoryPart[];
    partIndex: Map<string, number>;
};

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

function configuredOpenCodeProviderIds(): Set<string> {
    const out = new Set<string>();
    const configuredHome = expandHome(ocConfig().get<string>('home') || '');
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '~', '.config');
    const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
    for (const file of [
        process.env.OPENCODE_CONFIG || '',
        configuredHome ? path.join(configuredHome, 'opencode.json') : '',
        configuredHome ? path.join(configuredHome, 'opencode.jsonc') : '',
        path.join(xdgConfig, 'opencode', 'opencode.json'),
        path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
    ]) {
        if (file) addProviderKeysFromFile(out, file);
    }
    for (const file of [
        configuredHome ? path.join(configuredHome, 'auth.json') : '',
        path.join(xdgConfig, 'opencode', 'auth.json'),
        path.join(xdgData, 'opencode', 'auth.json'),
    ]) {
        if (file) addAuthKeysFromFile(out, file);
    }
    return out;
}

/** Sync best-effort: is opencode usable (configured server URL, or a resolvable
 *  binary we can `serve`)? Used so a configured-but-not-yet-running opencode reads
 *  "Switch bridge" in the picker instead of "setup required" — connect() spawns
 *  the server on switch. Kept OUT of isConnected() (connect() early-returns on it). */
function ocInstalled(): boolean {
    if (ocServerUrl()) return true;
    try { const b = ocBinaryPath(); return path.isAbsolute(b) && require('fs').existsSync(b); } catch { return false; }
}

function workspaceDirectory(folderUri?: vscode.Uri): string {
    return folderUri?.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function opencodeApiUrl(baseUrl: string, endpoint: string, folderUri?: vscode.Uri): string {
    const clean = endpoint.replace(/^\/+/, '').replace(/^api\/?/, '');
    const url = new URL(`api/${clean}`, baseUrl.replace(/\/$/, '') + '/');
    if (folderUri) url.searchParams.set('location[directory]', workspaceDirectory(folderUri));
    return url.toString();
}

function withQuery(raw: string, params: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(raw);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
}

function opencodeLocation(folderUri?: vscode.Uri): { directory: string } {
    return { directory: workspaceDirectory(folderUri) };
}

function unwrapData<T = any>(res: any, fallback: T): T {
    if (res && Object.prototype.hasOwnProperty.call(res, 'data')) return res.data as T;
    return (res ?? fallback) as T;
}

function cliToolOutput(state: any): string {
    if (state == null) return '';
    if (typeof state.output === 'string') return state.output;
    if (state.output !== undefined) return JSON.stringify(state.output);
    if (typeof state.title === 'string') return state.title;
    return '';
}

function uriFromPathish(raw?: string): vscode.Uri | undefined {
    if (!raw) return undefined;
    try { return raw.includes(':') ? vscode.Uri.parse(raw) : vscode.Uri.file(raw); } catch { return undefined; }
}

function isNativeOpenCodeSessionId(id: string | null | undefined): id is string {
    return /^ses_/.test(String(id || ''));
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
        timelineInterleaves: true,
    };

    private process: ChildProcess | null = null;
    private baseUrl = '';
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, KnownOpenCodeSession>();
    // Bridge-local conversation record. opencode's HTTP `session.messages`
    // endpoint reads the v2 `session_message` projection, which for CLI-`run`
    // sessions only contains agent/model-switched meta — the real user/assistant
    // turns live in the v1 `message`/`part` tables and are not served. So we keep
    // our own transcript (persisted to workspaceState) and replay it as history.
    private sessionTranscripts = new Map<string, HistoryMessage[]>();
    private mapperStates = new Map<string, OpenCodeMapperState>();
    private runBySession = new Map<string, string>();
    private cliRuns = new Map<string, ChildProcess>();
    private eventAbort: AbortController | null = null;
    private eventLocationKey = '';
    private commandCache: Array<{ name: string; description?: string; template?: string }> = [];

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, KnownOpenCodeSession]>>('junction.opencode.knownSessions');
        if (saved) this.knownSessions = new Map(saved);
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.opencode.activeSessionId', null);
        const savedTranscripts = this.context.workspaceState.get<Array<[string, HistoryMessage[]]>>('junction.opencode.transcripts');
        if (savedTranscripts) this.sessionTranscripts = new Map(savedTranscripts);
    }

    private persistSessions(): void {
        this.context.workspaceState.update('junction.opencode.knownSessions', Array.from(this.knownSessions.entries()));
        this.context.workspaceState.update('junction.opencode.activeSessionId', this.activeSessionId);
        this.context.workspaceState.update('junction.opencode.transcripts', Array.from(this.sessionTranscripts.entries()));
    }

    private recordTranscript(sessionKey: string | null | undefined, message: HistoryMessage): void {
        const key = String(sessionKey || '').trim();
        if (!key) return;
        const list = this.sessionTranscripts.get(key) || [];
        list.push(message);
        // Cap to keep workspaceState small; history view loads the tail anyway.
        if (list.length > 400) list.splice(0, list.length - 400);
        this.sessionTranscripts.set(key, list);
        this.persistSessions();
    }

    /** Move a recorded transcript when a pending id is replaced by a native ses_*. */
    private migrateTranscript(fromKey: string | null | undefined, toKey: string): void {
        const from = String(fromKey || '').trim();
        if (!from || from === toKey) return;
        const prior = this.sessionTranscripts.get(from);
        if (!prior?.length) return;
        const merged = (this.sessionTranscripts.get(toKey) || []).concat(prior);
        this.sessionTranscripts.set(toKey, merged);
        this.sessionTranscripts.delete(from);
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

        this.startEventStream(vscode.workspace.workspaceFolders?.[0]?.uri);
        this.loadCommands().catch(() => {});
        this.emit('connected');
        return true;
    }

    private async ping(): Promise<boolean> {
        try { await textRequest(opencodeApiUrl(this.baseUrl, 'provider'), { timeoutMs: 800 }); return true; } catch { return false; }
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
            try { await textRequest(opencodeApiUrl(url, 'provider'), { timeoutMs: 500 }); this.baseUrl = url; return true; } catch {}
            await new Promise((r) => setTimeout(r, 250));
        }
        Logger.getInstance().error('opencode server did not come up on ' + url);
        if (this.process) { this.process.kill(); this.process = null; }
        return false;
    }

    private startEventStream(folderUri?: vscode.Uri): void {
        const nextLocation = workspaceDirectory(folderUri);
        if (this.eventAbort && this.eventLocationKey === nextLocation) return;
        if (this.eventAbort) {
            this.eventAbort.abort();
            this.eventAbort = null;
        }
        this.eventLocationKey = nextLocation;
        this.eventAbort = new AbortController();
        const eventUrl = opencodeApiUrl(this.baseUrl, 'event', vscode.Uri.file(nextLocation));
        const run = () => {
            if (!this.baseUrl || !this.eventAbort) return;
            streamSse(eventUrl, { method: 'GET', timeoutMs: 0, signal: this.eventAbort.signal }, (ev) => {
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
        this.eventLocationKey = '';
        if (this.process) { this.process.kill(); this.process = null; }
        for (const child of this.cliRuns.values()) child.kill();
        this.cliRuns.clear();
        this.baseUrl = '';
        this.runBySession.clear();
        this.mapperStates.clear();
        this.emit('disconnected');
    }

    private stopServerProcess(): void {
        if (this.eventAbort) { this.eventAbort.abort(); this.eventAbort = null; }
        this.eventLocationKey = '';
        if (this.process) { this.process.kill(); this.process = null; }
        this.baseUrl = '';
    }

    isConnected(): boolean { return !!this.baseUrl; }

    async initializeWorkspace(): Promise<void> {}
    async registerRuntimeIntegrations(): Promise<void> {}
    async configure(): Promise<void> { vscode.commands.executeCommand('junction.openSettings'); }

    setPendingFileContext(context: string): void { this.pendingFileContext = context; }
    getPendingFileContext(): string | null { const c = this.pendingFileContext; this.pendingFileContext = null; return c; }

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

    private sessionFolder(sessionKey: string | null | undefined, fallback?: vscode.Uri): vscode.Uri | undefined {
        if (fallback) return fallback;
        const bound = this.boundSessionWorkspace(sessionKey);
        if (bound) return bound;
        return uriFromPathish(sessionKey ? this.knownSessions.get(sessionKey)?.workspaceUri : undefined);
    }

    private normalizeSession(row: any, archivedKeys: ReadonlySet<string>, fallback?: KnownOpenCodeSession): BridgeSession | null {
        const key = String(row?.id ?? row?.sessionID ?? '');
        if (!isNativeOpenCodeSessionId(key)) return null;
        const locationDirectory = typeof row?.location?.directory === 'string'
            ? row.location.directory
            : (typeof row?.directory === 'string' ? row.directory : fallback?.workspaceUri);
        const model = typeof row?.model === 'string'
            ? row.model
            : (row?.model?.providerID && row?.model?.modelID
                ? `${row.model.providerID}/${row.model.modelID}`
                : (row?.model?.providerID && row?.model?.id ? `${row.model.providerID}/${row.model.id}` : fallback?.model));
        const updated = row?.time?.updated ?? row?.time?.created ?? row?.updatedAt ?? row?.createdAt;
        return {
            key,
            title: String(row?.title || fallback?.title || row?.slug || key),
            model,
            isActive: key === this.activeSessionId,
            isArchived: archivedKeys.has(key) || !!row?.time?.archived,
            groupId: this.id,
            groupLabel: this.id,
            workspaceUri: locationDirectory || undefined,
            workspaceName: fallback?.workspaceName,
            lastActiveTs: typeof updated === 'number' ? updated : undefined,
        };
    }

    async createChat(folderUri?: vscode.Uri): Promise<string> {
        // opencode's current headless `serve` API can create sessions that the
        // native CLI runner will not continue. Use a local pending id and let
        // `opencode run` create the real native `ses_*` on first prompt.
        const id = `opencode-pending-${Date.now()}`;
        this.activeSessionId = id;
        this.knownSessions.set(id, {
            title: 'New chat',
            model: this.selection.modelId,
            workspaceUri: folderUri?.fsPath || workspaceDirectory(),
        });
        this.bindSessionWorkspace(id, folderUri);
        this.persistSessions();
        return id;
    }

    private async ensureNativeSession(folderUri?: vscode.Uri): Promise<string> {
        if (isNativeOpenCodeSessionId(this.activeSessionId)) return this.activeSessionId;
        // TEMP pre-publish migration: older dev builds stored fake `opencode-*`
        // session ids. New users cannot get these; prune before publish.
        if (this.activeSessionId) {
            this.knownSessions.delete(this.activeSessionId);
            this.activeSessionId = null;
            this.persistSessions();
        }
        return this.createChat(folderUri);
    }

    async forkChat(parentSessionKey: string, folderUri?: vscode.Uri): Promise<string | null> {
        try {
            const parent = await jsonRequest(opencodeApiUrl(this.baseUrl, `session/${encodeURIComponent(parentSessionKey)}/message`, this.sessionFolder(parentSessionKey, folderUri)), { timeoutMs: 8000 });
            const id = await this.createChat(folderUri);
            if (!id) return null;
            const title = this.knownSessions.get(parentSessionKey)?.title || 'Fork';
            this.knownSessions.set(id, { title: `Fork of ${title}`, workspaceUri: folderUri?.fsPath || workspaceDirectory() });
            void parent;
            this.persistSessions();
            return id;
        } catch (err) {
            Logger.getInstance().error('opencode forkChat failed', err);
            return null;
        }
    }

    async listSessions(_scope: ChatScope = 'all', includeArchived = false, archivedKeys: ReadonlySet<string> = new Set()): Promise<BridgeSession[]> {
        try {
            if (!this.baseUrl) await this.spawnServer();
            const res: any = await jsonRequest(withQuery(opencodeApiUrl(this.baseUrl, 'session'), { limit: 200, order: 'desc' }), { timeoutMs: 4000 });
            const raw = unwrapData<any[]>(res, []);
            const sessions: BridgeSession[] = [];
            for (const row of Array.isArray(raw) ? raw : []) {
                const session = this.normalizeSession(row, archivedKeys, this.knownSessions.get(String(row?.id ?? '')));
                if (!session) continue;
                if (!includeArchived && session.isArchived) continue;
                sessions.push(session);
                this.knownSessions.set(session.key, {
                    title: session.title,
                    model: session.model,
                    workspaceUri: session.workspaceUri,
                    workspaceName: session.workspaceName,
                });
            }
            this.persistSessions();
            return sessions;
        } catch {
            return Array.from(this.knownSessions.entries())
                .filter(([key]) => isNativeOpenCodeSessionId(key))
                .filter(([key]) => includeArchived || !archivedKeys.has(key))
                .map(([key, v]) => ({ key, title: v.title, model: v.model, workspaceUri: v.workspaceUri, workspaceName: v.workspaceName }));
        }
    }

    async listWorkspaceSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>, currentFolder?: vscode.Uri): Promise<BridgeSession[]> {
        const sessions = await this.listSessions('all', includeArchived, archivedKeys);
        return decorateSessionsWithWorkspaceBindings(
            this.context,
            this.id,
            sessions,
            scope,
            currentFolder,
            false,
            (session) => {
                const raw = String(session.workspaceUri || '').trim();
                if (!raw) return undefined;
                const parsed = raw.includes(':') ? vscode.Uri.parse(raw) : vscode.Uri.file(raw);
                const name = session.workspaceName
                    || vscode.workspace.getWorkspaceFolder(parsed)?.name
                    || parsed.fsPath.split(/[\\/]/).filter(Boolean).pop()
                    || parsed.path.split('/').filter(Boolean).pop()
                    || parsed.toString();
                return { workspaceUri: parsed.toString(), workspaceName: name };
            },
        );
    }

    async renameSession(key: string, label: string): Promise<void> {
        // Native opencode v2 currently has no rename endpoint; keep Junction-local title.
        const e = this.knownSessions.get(key) ?? { title: label };
        e.title = label;
        this.knownSessions.set(key, e);
        this.persistSessions();
    }

    async getSessionHistory(limit = 200, _folderUri?: vscode.Uri): Promise<HistoryMessage[]> {
        const sessionId = this.activeSessionId;
        if (!sessionId) return [];
        // Prefer our own transcript: opencode's HTTP `session.messages` returns
        // only the v2 meta projection for CLI-`run` sessions (see sessionTranscripts).
        const local = this.sessionTranscripts.get(sessionId);
        if (local?.length) {
            const history = local.slice(-limit);
            captureBridgeHistoryDebug(this.id, 'history-native', {
                operation: 'getSessionHistory.localTranscript',
                sessionKey: sessionId,
                inputCount: local.length,
                inputMessages: local,
            });
            captureBridgeHistoryDebug(this.id, 'history-normalized', {
                operation: 'getSessionHistory.localTranscript',
                sessionKey: sessionId,
                outputCount: history.length,
                outputMessages: history,
            });
            return history;
        }
        if (!isNativeOpenCodeSessionId(sessionId)) return [];
        try {
            if (!this.baseUrl) await this.spawnServer();
            const res: any = await jsonRequest(withQuery(opencodeApiUrl(this.baseUrl, `session/${encodeURIComponent(sessionId)}/message`, this.sessionFolder(sessionId)), { limit, order: 'asc' }), { timeoutMs: 8000 });
            const rows = unwrapData<any[]>(res, []);
            captureBridgeHistoryDebug(this.id, 'history-native', {
                operation: 'getSessionHistory.http',
                sessionKey: sessionId,
                inputCount: rows.length,
                inputMessages: rows,
            });
            const out: HistoryMessage[] = [];
            for (const row of rows) {
                const info = row.info || row;
                const parts: any[] = row.parts || row.content || [];
                if (info.role === 'user') {
                    const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('');
                    out.push({ role: 'user', content: text });
                } else if (row.type === 'user') {
                    out.push({ role: 'user', content: String(row.text || '') });
                } else if (row.type === 'shell') {
                    out.push({
                        role: 'assistant',
                        content: [{
                            type: 'toolCall',
                            toolName: 'shell',
                            toolCallId: row.callID,
                            input: { command: row.command },
                            text: typeof row.output === 'string' ? row.output : undefined,
                        }],
                    });
                } else {
                    const content: HistoryPart[] = [];
                    for (const p of parts) {
                        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
                        else if (p.type === 'reasoning' && p.text) content.push({ type: 'reasoning', text: p.text });
                        else if (p.type === 'tool') content.push({
                            type: 'toolCall',
                            toolName: p.tool || p.name,
                            toolCallId: p.callID || p.id,
                            input: p.state?.input,
                            result: p.state?.result,
                            text: typeof p.state?.output === 'string' ? p.state.output : undefined,
                            isError: p.state?.status === 'error',
                        });
                    }
                    if (row.type === 'assistant' || info.role === 'assistant') out.push({ role: 'assistant', content });
                }
            }
            captureBridgeHistoryDebug(this.id, 'history-normalized', {
                operation: 'getSessionHistory.http',
                sessionKey: sessionId,
                outputCount: out.length,
                outputMessages: out,
            });
            return out;
        } catch (err) {
            Logger.getInstance().error('opencode getSessionHistory failed', err);
            return [];
        }
    }

    // ── Send / stop / steer ─────────────────────────────────────────────────

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        const folder = context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined;
        const runId = `opencode-${Date.now()}`;
        const sessionId = isNativeOpenCodeSessionId(this.activeSessionId) ? this.activeSessionId : null;
        const visibleSession = sessionId || this.activeSessionId || runId;
        if (visibleSession) this.runBySession.set(visibleSession, runId);
        this.mapperStates.set(visibleSession, newOpenCodeMapperState());
        this.recordTranscript(visibleSession, { role: 'user', content: message });
        captureBridgeDebug(this.id, 'request', {
            operation: 'sendChatMessage',
            sessionKey: visibleSession,
            runId,
            nativeSessionId: sessionId,
            message,
            context,
        });
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: visibleSession });
        this.spawnCliRun({ runId, sessionId, message, folder });
        return { runId, sessionKey: visibleSession };
    }

    async executeSlashCommand(command: string, context?: BridgeContext): Promise<any> {
        const parsed = parseSlashCommand(command);
        if (!parsed) return this.sendChatMessage(command, context);
        const runId = `opencode-command-${Date.now()}`;
        const folder = context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined;
        const sessionId = isNativeOpenCodeSessionId(this.activeSessionId) ? this.activeSessionId : null;
        const visibleSession = sessionId || this.activeSessionId || runId;
        this.runBySession.set(visibleSession, runId);
        this.mapperStates.set(visibleSession, newOpenCodeMapperState());
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: visibleSession });
        const commandInfo = this.commandCache.find((c: any) => c.name === parsed.name) as any;
        const template = typeof commandInfo?.template === 'string' && commandInfo.template.trim()
            ? commandInfo.template
            : `/${parsed.name}`;
        const text = parsed.args ? `${template}\n\n${parsed.args}` : template;
        this.recordTranscript(visibleSession, { role: 'user', content: command });
        captureBridgeDebug(this.id, 'request', {
            operation: 'executeSlashCommand',
            sessionKey: visibleSession,
            runId,
            nativeSessionId: sessionId,
            command,
            parsed,
            outboundText: text,
            context,
        });
        this.spawnCliRun({ runId, sessionId, message: text, folder, command: parsed.name, commandArgs: parsed.args });
        return { runId, sessionKey: visibleSession };
    }

    private selectedProviderModel(): { providerID: string; model: string } | null {
        const id = this.selection.modelId;
        if (!id) return null;
        const slash = id.indexOf('/');
        if (slash <= 0) return null;
        return { providerID: id.slice(0, slash), model: id.slice(slash + 1) };
    }

    private sessionModelParts(): OpenCodeSessionModelRef | null {
        const selected = this.selectedProviderModel();
        return selected ? { providerID: selected.providerID, id: selected.model } : null;
    }

    private spawnCliRun(input: {
        runId: string;
        sessionId: string | null;
        message: string;
        folder?: vscode.Uri;
        command?: string;
        commandArgs?: string;
    }): void {
        this.stopServerProcess();
        const cwd = workspaceDirectory(input.folder);
        // --thinking makes `run` emit reasoning parts in json (off by default for
        // non-interactive); without it reasoning models stay silent in the timeline.
        const args = ['run', '--format', 'json', '--thinking', '--dir', cwd];
        if (input.sessionId) args.push('--session', input.sessionId);
        const model = this.selection.modelId;
        if (model) args.push('--model', model);
        if (this.selection.agentId) args.push('--agent', this.selection.agentId);
        if (this.selection.thinking && this.selection.thinking !== 'off') args.push('--variant', this.selection.thinking);
        if (input.command) args.push('--command', input.command);
        args.push(input.command ? (input.commandArgs || '') : input.message);

        // stdin MUST be detached (/dev/null). With a default open pipe, opencode
        // sees a non-TTY stdin and blocks on `Bun.stdin.text()` waiting for EOF
        // that never comes — the run hangs, emits nothing, then dies as "exited
        // with code null". Ignoring stdin gives an immediate EOF.
        const child = spawn(ocBinaryPath(), args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        this.cliRuns.set(input.runId, child);
        let buffer = '';
        let stderr = '';
        let currentSession = input.sessionId || this.activeSessionId || input.runId;
        let completed = false;
        // opencode emits one text part per step. Intermediate steps (reason
        // "tool-calls") are the model's running narration between tool calls;
        // only the final step (reason "stop"/other) is the reply. Defer text to
        // its step_finish so narration interleaves with tools as timeline notes
        // and the blob doesn't all land in one reply bubble at the bottom.
        const runState: RunAccumulator = {
            stepText: new Map<string, string>(),
            replyParts: [],
            emittedNotes: new Set<string>(),
            parts: [],
            partIndex: new Map<string, number>(),
        };
        const handleLine = (line: string) => {
            if (!line.trim()) return;
            let payload: any;
            try { payload = JSON.parse(line); } catch { return; }
            captureBridgeDebug(this.id, 'native', {
                operation: 'spawnCliRun.stdout',
                sessionKey: currentSession,
                runId: input.runId,
                payload,
            });
            const sid = payload.sessionID || payload.part?.sessionID || currentSession;
            if (isNativeOpenCodeSessionId(sid) && sid !== this.activeSessionId) {
                this.adoptNativeCliSession(sid, currentSession, input.folder);
                currentSession = sid;
                this.runBySession.set(sid, input.runId);
            }
            this.mapCliRunEvent(input.runId, sid, payload, runState);
            // Only `error` is terminal at the line level. `step_finish` fires after
            // every step (reason "tool-calls" between tool calls, then "stop"), so a
            // tool-using run emits several; completion is the process exiting.
            if (payload.type === 'error') completed = true;
        };
        child.stdout?.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) handleLine(line);
        });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('exit', (code) => {
            if (buffer.trim()) handleLine(buffer);
            // If the run ended without a terminal step_finish (kill/crash), surface
            // any step text that was never resolved as narration or reply.
            if (!runState.replyParts.length) {
                const pending = Array.from(runState.stepText.entries())
                    .filter(([mid]) => !runState.emittedNotes.has(mid))
                    .map(([, t]) => t).filter(Boolean);
                const reply = pending.join('\n\n');
                if (reply) {
                    this.recordPart(runState, 'reply:flush', { type: 'text', text: reply });
                    this.emit('stream', { type: 'agent_message', runId: input.runId, sessionKey: currentSession, text: reply });
                }
            }
            this.cliRuns.delete(input.runId);
            if (!completed && code !== 0) {
                const text = stderr.trim() || `opencode exited with code ${code}`;
                runState.parts.push({ type: 'text', text: `Error: ${text}` });
                this.emit('stream', { type: 'agent_message', runId: input.runId, sessionKey: currentSession, text: `Error: ${text}` });
                this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId: input.runId, sessionKey: currentSession });
            } else if (!completed) {
                this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId: input.runId, sessionKey: currentSession });
            }
            if (runState.parts.length) this.recordTranscript(currentSession, { role: 'assistant', content: runState.parts });
            this.runBySession.delete(currentSession);
            this.mapperStates.delete(currentSession);
        });
        child.on('error', (err) => {
            this.cliRuns.delete(input.runId);
            this.emit('stream', { type: 'agent_message', runId: input.runId, sessionKey: currentSession, text: `Error: ${err.message || err}` });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId: input.runId, sessionKey: currentSession });
        });
    }

    private adoptNativeCliSession(nativeId: string, previousKey: string | null | undefined, folder?: vscode.Uri): void {
        const previous = previousKey ? this.knownSessions.get(previousKey) : undefined;
        this.activeSessionId = nativeId;
        this.knownSessions.set(nativeId, {
            title: previous?.title || 'New chat',
            model: this.selection.modelId || previous?.model,
            workspaceUri: previous?.workspaceUri || folder?.fsPath || workspaceDirectory(folder),
            workspaceName: previous?.workspaceName,
        });
        if (previousKey && previousKey !== nativeId && !isNativeOpenCodeSessionId(previousKey)) this.knownSessions.delete(previousKey);
        this.migrateTranscript(previousKey, nativeId);
        this.bindSessionWorkspace(nativeId, folder);
        this.persistSessions();
    }

    /** Record/replace an assistant content part in arrival order (keyed for snapshot dedup). */
    private recordPart(runState: RunAccumulator, key: string, part: HistoryPart): void {
        const existing = runState.partIndex.get(key);
        if (existing !== undefined) { runState.parts[existing] = part; return; }
        runState.partIndex.set(key, runState.parts.length);
        runState.parts.push(part);
    }

    private mapCliRunEvent(runId: string, sessionKey: string, payload: any, runState: RunAccumulator): void {
        const part = payload.part || {};
        const type = payload.type;
        captureBridgeDebug(this.id, 'normalized', {
            operation: 'mapCliRunEvent',
            sessionKey,
            runId,
            eventType: type || part.type,
            payload,
        });
        if (type === 'text' || part.type === 'text') {
            // Defer: a text part's role (narration vs reply) isn't known until its
            // step_finish carries the reason. Keyed by step messageID.
            const mid = String(part.messageID || part.id || payload.id || 'text');
            runState.stepText.set(mid, String(part.text ?? payload.text ?? ''));
            return;
        }
        if (type === 'step_finish' || part.type === 'step-finish') {
            const mid = String(part.messageID || '');
            const text = (mid && runState.stepText.get(mid)) || '';
            // "tool-calls" → more tools coming, this step's text is narration.
            // Anything else (stop, length, …) → terminal step, its text is reply.
            const isFinal = String(part.reason || '') !== 'tool-calls';
            if (isFinal) {
                if (text) {
                    runState.replyParts.push(text);
                    this.recordPart(runState, 'reply:' + mid, { type: 'text', text });
                }
                const reply = runState.replyParts.filter(Boolean).join('\n\n');
                if (reply) this.emit('stream', { type: 'agent_message', runId, sessionKey, text: reply });
            } else if (text && !runState.emittedNotes.has(mid)) {
                runState.emittedNotes.add(mid);
                this.recordPart(runState, 'note:' + mid, { type: 'reasoning', text });
                this.emit('stream', { type: 'thinking_chunk', runId, sessionKey, text });
            }
            return;
        }
        if (type === 'reasoning' || part.type === 'reasoning') {
            const id = String(part.id || payload.id || 'reasoning');
            const text = String(part.text ?? payload.text ?? '');
            if (text) {
                this.recordPart(runState, 'reasoning:' + id, { type: 'reasoning', text });
                this.emit('stream', { type: 'thinking_chunk', runId, sessionKey, text });
            }
            return;
        }
        if (type === 'tool_use' || type === 'tool' || part.type === 'tool') {
            const callId = part.callID || part.id || `tool-${Date.now()}`;
            const status = part.state?.status;
            const toolName = part.tool || '';
            const args = part.state?.input || {};
            if (status === 'pending' || status === 'running') {
                this.emit('stream', { type: 'tool_event', phase: 'start', runId, sessionKey, toolCallId: callId, toolName, args });
                return;
            }
            // opencode emits a single tool_use at completion carrying both input
            // and output. Emit start (so the card shows arguments) then result.
            const output = cliToolOutput(part.state);
            this.recordPart(runState, 'tool:' + callId, {
                type: 'toolCall', toolName, toolCallId: callId, input: args,
                result: part.state?.result, text: typeof output === 'string' ? output : undefined,
                isError: status === 'error',
            });
            this.emit('stream', { type: 'tool_event', phase: 'start', runId, sessionKey, toolCallId: callId, toolName, args });
            this.emit('stream', { type: 'tool_event', phase: 'result', runId, sessionKey, toolCallId: callId, toolName, result: output, isError: status === 'error' });
            return;
        }
        if (type === 'error') {
            const msg = payload.error?.data?.message || payload.error?.message || payload.error?.name || payload.message || 'unknown error';
            this.emit('stream', { type: 'agent_message', runId, sessionKey, text: `Error: ${msg}` });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey });
            return;
        }
        // step_start (and step_finish, handled above) are non-terminal. The CLI
        // breaks its event loop on `session.status` idle (not in json), so the run
        // completes when the process exits — handled in spawnCliRun's exit handler.
    }

    async stopRun(sessionKey?: string, _runId?: string): Promise<void> {
        const id = sessionKey || this.activeSessionId;
        if (!id) return;
        const runId = _runId || this.runBySession.get(id) || `opencode-stop-${Date.now()}`;
        const child = this.cliRuns.get(runId);
        if (child) { child.kill('SIGTERM'); this.cliRuns.delete(runId); }
        // Native opencode v2 has `Session.interrupt` internally, but no public
        // HTTP abort endpoint in packages/server/src/groups. Do local cleanup.
        this.runBySession.delete(id);
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId, sessionKey: id });
    }

    async getUsage(): Promise<any> { return null; }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        if (!isNativeOpenCodeSessionId(sessionKey)) return false;
        try {
            const runId = `opencode-steer-${Date.now()}`;
            this.spawnCliRun({ runId, sessionId: sessionKey, message, folder: this.sessionFolder(sessionKey) });
            return true;
        } catch { return false; }
    }

    canSteer(): boolean { return true; }
    canAdminInject(): boolean { return false; }

    // ── Models ────────────────────────────────────────────────────────────

    setSelection(selection: BridgeSelectionState): void { this.selection = { ...this.selection, ...selection }; }

    getSelection(): BridgeSelectionState { return { ...this.selection }; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        const live = await listOpenCodeModelChoices(this.baseUrl, selectedModel, selectedThinking);
        return organizeOpenCodeModelChoices(live, configuredOpenCodeProviderIds());
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const selected = selectOpenCodeModelChoice(data, this.selection);
        if (!selected) return null;
        const { modelId, thinking } = selected;
        this.setSelection({ ...this.selection, modelId, thinking });
        return selected;
    }

    // ── Environment ─────────────────────────────────────────────────────────

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const connected = this.isConnected();
        const detected = ocInstalled();
        const usable = connected || detected;
        return [{
            id: 'opencode:status',
            label: connected ? `Connected (${this.baseUrl})` : (usable ? 'opencode ready' : 'Not connected'),
            description: connected
                ? 'opencode server running'
                : (usable
                    ? (ocServerUrl() ? `External: ${ocServerUrl()}` : 'Server starts on switch')
                    : 'Set junction.opencode.serverUrl or install opencode'),
            icon: connected ? 'check' : (usable ? 'hubot' : 'warning'),
            // Only an unconfigured/uninstalled opencode is a genuine "needs setup"
            // notice. A configured one is usable (connect() spawns the server on
            // switch), so keep it in the registry's hasConfigured tally → the
            // bridge button reads "Switch bridge", not "setup required".
            setup: !detected,
            bridgeId: 'opencode',
        }, {
            id: 'opencode:configure',
            label: 'Configure opencode',
            description: 'Bridge settings',
            icon: 'gear',
            setup: true,
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
            const res: any = await jsonRequest(opencodeApiUrl(this.baseUrl, 'command'), { timeoutMs: 3000 });
            const list = unwrapData<any[]>(res, []);
            this.commandCache = list.map((c) => ({ name: c.name, description: c.description, template: c.template } as any));
        } catch { /* leave cache */ }
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const p = prefix.replace(/^\//, '').toLowerCase();
        return this.commandCache.filter((c) => !p || c.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null { return null; }
}
