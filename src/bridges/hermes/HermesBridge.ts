import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { getHermesApiBaseUrl, getHermesApiKey, getHermesBaseUrl, getHermesHome, getHermesMode, getHermesWsUrl, hermesConfig, updateHermesRuntime } from '../../config/agentBridgeConfig';
import { jsonRequest, streamSse, textRequest } from '../http';
import { BridgeCapabilities, BridgeContext, BridgeSelectionState, BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, ModelChoice, ToolStatusView } from '../types';
import { Logger } from '../../utils/logger';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';
import { mapHermesWsEvent } from './events';
import { HermesModelPicker } from './modelPicker';
import { parseSlashCommand, slashRunId } from '../slashCommands';
import { bindHermesSessionWorkspace, boundHermesSessionWorkspace, decorateHermesWorkspaceSessions } from './workspaceSessions';
import { commandOutputToMarkdown, parseHermesCommandOutput } from '../commandOutput';

const execFileAsync = promisify(execFile);

interface Pending {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
}

interface HermesLiveSession {
    id?: string;
    session_key?: string;
    title?: string;
    model?: string;
    status?: string;
}

interface HermesSlashDispatch {
    type?: string;
    output?: string;
    warning?: string;
    target?: string;
    message?: string;
    notice?: string;
    name?: string;
}

export class HermesBridge extends EventEmitter implements ChatBridge {
    readonly id = 'hermes';
    readonly label = 'Hermes';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: false,
        steering: true,
        usage: true,
        tools: true,
        // Hermes stores one reasoning blob + a batch of tool calls per step, so in
        // timeline mode its thoughts must interleave with tools, not coalesce.
        timelineInterleaves: true,
    };

    private ws: WebSocket | null = null;
    private pending = new Map<string, Pending>();
    private requestId = 0;
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string; model?: string }>();
    private liveSessionByKey = new Map<string, string>();
    private sessionKeyByLive = new Map<string, string>();
    private buffers = new Map<string, string>();
    private yoloEnabledBySession = new Set<string>();
    private reasoningAppliedBySession = new Map<string, string>();
    private modelAppliedBySession = new Set<string>();

    // ── API-server (OpenAI-compatible) transport ─────────────────────────────
    // Used when the gateway exposes platforms.api_server but no dashboard is up.
    private apiMode = false;
    private apiConnected = false;
    private apiBase = '';
    private apiKey = '';
    private apiAbort: AbortController | null = null;
    // The API server is stateless, so the bridge tracks conversation history
    // client-side and replays it on each request.
    private apiHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
    private readonly modelPicker: HermesModelPicker;

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        this.modelPicker = new HermesModelPicker({
            isApiMode: () => this.apiMode,
            apiBase: () => this.apiBase,
            apiHeaders: (key?: string) => this.apiHeaders(key),
            ensureConnected: () => this.ensureConnected(),
            request: <T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000) => this.request<T>(method, params, timeoutMs),
            selection: () => this.selection,
            setSelection: (selection: BridgeSelectionState) => this.setSelection(selection),
            activeSessionId: () => this.activeSessionId,
            setSessionConfig: (key: string, value: string) => this.setSessionConfig(key, value),
            updateActiveSessionModel: (modelId: string) => {
                if (!this.activeSessionId) return;
                const known = this.knownSessions.get(this.activeSessionId) ?? { title: this.activeSessionId };
                known.model = modelId;
                this.knownSessions.set(this.activeSessionId, known);
                this.persistSessions();
            },
        });
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string }]>>('junction.hermes.knownSessions');
        if (saved) {
            this.knownSessions = new Map(saved);
        }
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.hermes.activeSessionId', null);
    }

    private persistSessions(): void {
        const data = Array.from(this.knownSessions.entries());
        this.context.workspaceState.update('junction.hermes.knownSessions', data);
        this.context.workspaceState.update('junction.hermes.activeSessionId', this.activeSessionId);
    }

    async connect(): Promise<boolean> {
        const mode = getHermesMode();
        try {
            if (mode === 'apiserver') {
                if (await this.connectApiServer()) { this.emit('connected'); return true; }
                throw new Error('Hermes API server not reachable');
            }
            await this.ensureManagedRuntime();
            await this.connectWs();
            this.apiMode = false;
            this.emit('connected');
            return true;
        } catch (err) {
            Logger.getInstance().warn('Hermes bridge connect failed', err);
            this.emit('disconnected');
            return false;
        }
    }

    private apiHeaders(key?: string): Record<string, string> {
        const k = key ?? this.apiKey;
        return k ? { authorization: `Bearer ${k}` } : {};
    }

    /** Verify and select the OpenAI-compatible API-server transport. */
    private async connectApiServer(): Promise<boolean> {
        const cfg = await readHermesApiConfig();
        if (cfg.enabled === false) return false;
        const base = cfg.apiPort ? `http://${cfg.apiHost ?? '127.0.0.1'}:${cfg.apiPort}` : getHermesApiBaseUrl();
        const key = getHermesApiKey() || cfg.apiKey || '';
        try {
            await jsonRequest(`${base}/v1/models`, { headers: this.apiHeaders(key), timeoutMs: 1500 });
        } catch {
            // Endpoint not answering yet — only accept if the gateway lockfile
            // says the API server is up (it may still be warming).
            const state = await readHermesGatewayState();
            if (!(state.running && state.apiServerConnected)) return false;
        }
        this.apiMode = true;
        this.apiConnected = true;
        this.apiBase = base;
        this.apiKey = key;
        if (base !== getHermesApiBaseUrl()) await updateHermesRuntime({ apiBaseUrl: base });
        Logger.getInstance().info(`Hermes bridge using API-server transport at ${base}`);
        return true;
    }

    disconnect(): void {
        this.apiAbort?.abort();
        this.apiAbort = null;
        this.apiMode = false;
        this.apiConnected = false;
        this.ws?.close();
        this.ws = null;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('Hermes bridge disconnected'));
        }
        this.pending.clear();
        this.emit('disconnected');
    }

    isConnected(): boolean {
        if (this.apiMode) return this.apiConnected;
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    async initializeWorkspace(): Promise<void> {
        await this.ensureManagedRuntime();
    }

    async registerRuntimeIntegrations(): Promise<void> {
        await this.ensureManagedRuntime();
    }

    async configure(): Promise<void> {
        const dashboardUrl = await vscode.window.showInputBox({
            title: 'Hermes dashboard URL',
            value: getHermesBaseUrl(),
            placeHolder: 'http://127.0.0.1:9119',
        });
        if (!dashboardUrl) return;
        const wsUrl = await vscode.window.showInputBox({
            title: 'Hermes WebSocket URL',
            value: getHermesWsUrl(),
            placeHolder: 'ws://127.0.0.1:9119/api/ws',
        });
        if (!wsUrl) return;
        const apiBaseUrl = await vscode.window.showInputBox({
            title: 'Hermes API base URL',
            value: getHermesApiBaseUrl(),
            placeHolder: 'http://127.0.0.1:8642',
        });
        if (!apiBaseUrl) return;
        const home = await vscode.window.showInputBox({
            title: 'Hermes home',
            value: getHermesHome(),
            placeHolder: '~/.hermes-hermling',
        });
        if (!home) return;
        await updateHermesRuntime({ dashboardUrl, wsUrl, apiBaseUrl, home });
        this.disconnect();
        await this.connect();
    }

    setPendingFileContext(context: string): void {
        this.pendingFileContext = context;
    }

    getPendingFileContext(): string | null {
        const ctx = this.pendingFileContext;
        this.pendingFileContext = null;
        return ctx;
    }

    getCurrentSessionKey(): string | null {
        return this.activeSessionId;
    }

    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> {
        return new Map();
    }

    setActiveSession(_folderUri: vscode.Uri, key: string): void {
        this.activeSessionId = key;
        this.context.workspaceState.update('junction.hermes.activeSessionId', key);
    }

    bindSessionWorkspace(sessionKey: string | null | undefined, folderUri?: vscode.Uri): void {
        bindHermesSessionWorkspace(this.context, sessionKey, folderUri);
    }

    boundSessionWorkspace(sessionKey: string | null | undefined): vscode.Uri | undefined {
        return boundHermesSessionWorkspace(this.context, sessionKey);
    }

    async createChat(): Promise<string> {
        const title = `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
        if (this.apiMode) {
            const key = `hermes-api-${Date.now()}`;
            this.activeSessionId = key;
            this.apiHistory.set(key, []);
            this.knownSessions.set(key, { title });
            this.persistSessions();
            return key;
        }
        await this.ensureConnected();
        const selected = parseHermesSelectedModel(this.selection.modelId);
        const reasoningEffort = normalizeHermesThinking(this.selection.thinking);
        const res = await this.request<{ session_id?: string; stored_session_id?: string; session_key?: string; session?: { id?: string; session_key?: string } }>('session.create', {
            title,
            source: 'vscode',
            ...(selected ? { model: selected.model, provider: selected.provider } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        });
        const liveId = res?.session_id || res?.session?.id || `hermes-${Date.now()}`;
        const key = res?.stored_session_id || res?.session_key || res?.session?.session_key || liveId;
        this.rememberLiveSession(key, liveId);
        this.activeSessionId = key;
        this.knownSessions.set(key, { title, ...(this.selection.modelId ? { model: this.selection.modelId } : {}) });
        this.persistSessions();
        return key;
    }

    async listSessions(_scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
        return this.listHermesSessionsRaw(includeArchived, archivedKeys);
    }

    async listWorkspaceSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>, currentFolder?: vscode.Uri): Promise<BridgeSession[]> {
        const sessions = await this.listHermesSessionsRaw(includeArchived, archivedKeys);
        return decorateHermesWorkspaceSessions({
            context: this.context,
            sessions,
            scope,
            currentFolder,
        });
    }

    private async listHermesSessionsRaw(includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
        if (!this.apiMode) {
            const rpcSessions = await this.listSessionsViaHermes(includeArchived, archivedKeys).catch((err) => {
                Logger.getInstance().warn('Hermes session.list failed', err);
                return null;
            });
            if (rpcSessions?.length) return rpcSessions;
            const dbSessions = await this.listSessionsFromStateDb(includeArchived, archivedKeys).catch((err) => {
                Logger.getInstance().warn('Hermes state.db session list failed', err);
                return null;
            });
            if (dbSessions?.length) return dbSessions;
        }
        const items: BridgeSession[] = [...this.knownSessions.entries()]
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
        return items;
    }

    async renameSession(key: string, label: string): Promise<void> {
        if (!this.apiMode && this.isConnected()) {
            const previous = this.activeSessionId;
            this.activeSessionId = key;
            try {
                const liveId = await this.resolveLiveSessionId(false);
                if (liveId) {
                    await this.request('session.title', { session_id: liveId, title: label }, 10000);
                }
            } catch (err) {
                Logger.getInstance().warn('Hermes native rename failed', err);
            } finally {
                this.activeSessionId = previous;
            }
        }
        const existing = this.knownSessions.get(key) ?? { title: label };
        existing.title = label;
        this.knownSessions.set(key, existing);
        this.persistSessions();
    }

    async forkChat(parentSessionKey: string): Promise<string | null> {
        if (this.apiMode) return null;
        await this.ensureConnected();
        const previous = this.activeSessionId;
        this.activeSessionId = parentSessionKey;
        try {
            const liveId = await this.resolveLiveSessionId(false);
            if (!liveId) return null;
            const res = await this.request<{ session_id?: string; session_key?: string; stored_session_id?: string; title?: string; parent?: string }>(
                'session.branch',
                { session_id: liveId },
                120000,
            );
            const branchLiveId = res?.session_id;
            if (!branchLiveId) return null;
            const live = await this.findLiveSession(branchLiveId).catch(() => null);
            const key = live?.session_key || res.session_key || res.stored_session_id || branchLiveId;
            this.rememberLiveSession(key, branchLiveId);
            this.activeSessionId = key;
            this.knownSessions.set(key, {
                title: res.title || live?.title || key,
                model: live?.model,
            });
            this.persistSessions();
            return key;
        } catch (err) {
            this.activeSessionId = previous;
            Logger.getInstance().warn('Hermes native branch failed', err);
            return null;
        }
    }

    async getSessionHistory(): Promise<any> {
        if (this.apiMode) {
            const hist = this.activeSessionId ? (this.apiHistory.get(this.activeSessionId) ?? []) : [];
            captureBridgeHistoryDebug(this.id, 'history-native', {
                operation: 'getSessionHistory.api',
                sessionKey: this.activeSessionId,
                inputCount: hist.length,
                inputMessages: hist,
            });
            return {
                messages: hist.map((m) => m.role === 'user'
                    ? { role: 'user', content: m.content }
                    : { role: 'assistant', content: [{ type: 'text', text: m.content }] }),
            };
        }
        if (!this.activeSessionId) return { messages: [] };
        try {
            const dbMessages = await this.getSessionHistoryFromStateDb(this.activeSessionId).catch((err) => {
                Logger.getInstance().warn('Hermes state.db history failed', err);
                return null;
            });
            if (dbMessages?.length) {
                captureBridgeHistoryDebug(this.id, 'history-native', {
                    operation: 'getSessionHistory.stateDb',
                    sessionKey: this.activeSessionId,
                    inputCount: dbMessages.length,
                    inputMessages: dbMessages,
                });
                captureBridgeHistoryDebug(this.id, 'history-normalized', {
                    operation: 'getSessionHistory.stateDb',
                    sessionKey: this.activeSessionId,
                    outputCount: dbMessages.length,
                    outputMessages: dbMessages,
                });
                return { messages: dbMessages };
            }

            if (!this.isConnected()) return { messages: [] };
            const liveId = await this.resolveLiveSessionId(false);
            if (!liveId) return { messages: [] };
            const res = await this.request<{ count?: number; messages?: any[] }>(
                'session.history',
                { session_id: liveId },
                10000,
            );
            const rawMessages = Array.isArray(res?.messages) ? res.messages : [];
            captureBridgeHistoryDebug(this.id, 'history-native', {
                operation: 'getSessionHistory.native',
                sessionKey: this.activeSessionId,
                liveId,
                inputCount: rawMessages.length,
                inputMessages: rawMessages,
            });
            const messages: any[] = [];
            for (const msg of rawMessages) {
                if (!msg) continue;
                const role = msg.role;
                if (role === 'user') {
                    messages.push({ role, content: this.extractHermesMessageText(msg) });
                } else if (role === 'assistant') {
                    const content = this.normalizeHermesAssistantContent(msg);
                    if (content.length > 0) messages.push({ role, content });
                } else if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
                    messages.push({
                        role,
                        toolCallId: msg.toolCallId ?? msg.tool_call_id ?? msg.tool_id ?? msg.id,
                        toolName: msg.toolName ?? msg.tool_name ?? msg.name,
                        content: this.extractHermesMessageText(msg),
                        isError: !!(msg.isError ?? msg.error),
                    });
                }
            }
            captureBridgeHistoryDebug(this.id, 'history-normalized', {
                operation: 'getSessionHistory.native',
                sessionKey: this.activeSessionId,
                liveId,
                outputCount: messages.length,
                outputMessages: messages,
            });
            return { messages };
        } catch (err) {
            Logger.getInstance().warn('Failed to fetch Hermes session history', err);
            return { messages: [] };
        }
    }

    async getSessionHistoryFromJsonl(sessionKey: string, offset = 0, maxBytes = 256 * 1024): Promise<any> {
        if (this.apiMode) return { messages: [], hasMore: false, nextOffset: offset };
        const dbPath = path.join(getHermesHome(), 'state.db');
        if (!existsSync(dbPath)) return { messages: [], hasMore: false, nextOffset: offset };
        const keys = this.possibleStoredSessionKeys(sessionKey);
        const pageSize = Math.max(20, Math.min(200, Math.floor(maxBytes / 2048)));
        for (const key of keys) {
            const sql = `select id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, reasoning_content, reasoning_details, active from messages where session_id='${escapeSqlLiteral(key)}' and active=1 order by timestamp desc, id desc limit ${pageSize + 1} offset ${Math.max(0, offset)}`;
            const rows = await this.sqliteJson(dbPath, sql);
            if (!rows.length) continue;
            const hasMore = rows.length > pageSize;
            const selected = rows.slice(0, pageSize).reverse();
            const messages = selected.map((row) => this.hermesDbRowToHistoryMessage(row)).filter(Boolean);
            return {
                messages,
                hasMore,
                nextOffset: offset + selected.length,
            };
        }
        return { messages: [], hasMore: false, nextOffset: offset };
    }

    private normalizeHermesAssistantContent(msg: any): any[] {
        const raw = msg?.content ?? msg?.message?.content;
        if (Array.isArray(raw)) {
            const parts: any[] = [];
            for (const part of raw) {
                if (!part || typeof part !== 'object') {
                    const text = String(part ?? '').trim();
                    if (text) parts.push({ type: 'text', text });
                    continue;
                }
                const type = String(part.type ?? '').trim();
                if (type === 'thinking' || type === 'reasoning') {
                    const text = this.extractHermesMessageText(part);
                    if (text) parts.push({ type, text });
                    continue;
                }
                if (type === 'toolCall' || type === 'tool_use' || type === 'tool-call') {
                    parts.push(part);
                    continue;
                }
                const text = this.extractHermesMessageText(part);
                if (text) parts.push({ type: 'text', text });
            }
            return parts;
        }
        if (raw && typeof raw === 'object') {
            const text = this.extractHermesMessageText(raw);
            return text ? [{ type: 'text', text }] : [];
        }
        const text = this.extractHermesMessageText(msg);
        return text ? [{ type: 'text', text }] : [];
    }

    private async getSessionHistoryFromStateDb(sessionKey: string): Promise<any[] | null> {
        const dbPath = path.join(getHermesHome(), 'state.db');
        if (!existsSync(dbPath)) return null;
        for (const key of this.possibleStoredSessionKeys(sessionKey)) {
            const sql = `select id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, reasoning_content, reasoning_details, active from messages where session_id='${escapeSqlLiteral(key)}' and active=1 order by timestamp asc, id asc`;
            const rows = await this.sqliteJson(dbPath, sql);
            const messages = rows.map((row) => this.hermesDbRowToHistoryMessage(row)).filter(Boolean);
            if (messages.length) return messages;
        }
        return null;
    }

    private hermesDbRowToHistoryMessage(row: any): any | null {
        const role = String(row?.role ?? '');
        if (role === 'user') {
            return { role: 'user', content: row.content ?? '' };
        }
        if (role === 'assistant') {
            const content: any[] = [];
            const reasoning = this.extractHermesReasoning(row);
            if (reasoning) content.push({ type: 'thinking', text: reasoning });
            const text = typeof row.content === 'string' ? row.content : this.extractHermesMessageText(row.content);
            if (text) content.push({ type: 'text', text });
            content.push(...this.normalizeHermesDbToolCalls(row.tool_calls));
            return content.length ? { role: 'assistant', content } : null;
        }
        if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
            return {
                role: 'tool',
                toolCallId: row.tool_call_id ?? row.id,
                toolName: row.tool_name,
                content: this.formatHermesToolHistoryContent(row.content, true),
                isError: false,
            };
        }
        return null;
    }

    private normalizeHermesDbToolCalls(raw: any): any[] {
        const parsed = parseJsonLoose(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((call) => {
            const fn = call?.function ?? {};
            const args = parseJsonLoose(fn.arguments ?? call.arguments ?? {});
            const id = call?.call_id ?? call?.id ?? call?.response_item_id;
            return {
                type: 'toolCall',
                id,
                toolCallId: id,
                name: fn.name ?? call.name ?? call.tool_name,
                arguments: args,
            };
        }).filter((part) => part.toolCallId && part.name);
    }

    private extractHermesReasoning(row: any): string {
        for (const value of [row.reasoning_content, row.reasoning, row.reasoning_details]) {
            const text = this.formatHermesToolHistoryContent(value, false);
            if (text) return text;
        }
        return '';
    }

    private formatHermesToolHistoryContent(raw: any, preserveObjects: boolean): string {
        if (raw == null) return '';
        const parsed = parseJsonLoose(raw);
        if (typeof parsed === 'string') return parsed;
        if (Array.isArray(parsed)) {
            const text = parsed.map((part) => this.extractHermesMessageText(part)).filter(Boolean).join('\n\n');
            return text || (preserveObjects ? JSON.stringify(parsed, null, 2) : '');
        }
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.content === 'string') {
                const hint = parsed.truncated && typeof parsed.hint === 'string' ? `\n\n${parsed.hint}` : '';
                return parsed.content + hint;
            }
            if (typeof parsed.output === 'string') {
                const code = parsed.exit_code ?? parsed.exitCode;
                return code === undefined ? parsed.output : `${parsed.output.replace(/\s+$/, '')}\n\nExit code: ${code}`;
            }
            const text = this.extractHermesMessageText(parsed);
            return text || (preserveObjects ? JSON.stringify(parsed, null, 2) : '');
        }
        return String(parsed);
    }

    private extractHermesMessageText(value: any): string {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value.map((part) => this.extractHermesMessageText(part)).filter(Boolean).join('\n\n');
        }
        if (typeof value !== 'object') return String(value);
        const direct = value.text ?? value.delta ?? value.result_text ?? value.result ?? value.summary ?? value.content ?? value.message?.text;
        if (typeof direct === 'string') return direct;
        if (Array.isArray(direct)) return this.extractHermesMessageText(direct);
        if (direct && typeof direct === 'object') return this.extractHermesMessageText(direct);
        return '';
    }

    async sendChatMessage(message: string, _context?: BridgeContext): Promise<any> {
        captureBridgeDebug(this.id, 'request', {
            operation: 'sendChatMessage',
            sessionKey: this.activeSessionId,
            apiMode: this.apiMode,
            message,
        });
        if (this.apiMode) return this.sendViaApiServer(message);
        await this.ensureConnected();
        if (!this.activeSessionId) await this.createChat();
        const liveId = await this.resolveLiveSessionId(true);
        if (!liveId) throw new Error('Hermes session unavailable');
        await this.applyModelSelectionBeforeFirstPrompt(liveId);
        await this.applyReasoningSelection(liveId);
        await this.request('prompt.submit', { session_id: liveId, text: message }, 120000);
        return { session_id: this.activeSessionId, live_session_id: liveId };
    }

    async executeSlashCommand(command: string): Promise<any> {
        captureBridgeDebug(this.id, 'request', {
            operation: 'executeSlashCommand',
            sessionKey: this.activeSessionId,
            apiMode: this.apiMode,
            command,
        });
        if (this.apiMode) return this.sendViaApiServer(command);
        await this.executeHermesSlash(command);
        return { session_id: this.activeSessionId };
    }

    /** Stream a turn through the OpenAI-compatible /v1/chat/completions endpoint. */
    private async sendViaApiServer(message: string): Promise<any> {
        if (!this.activeSessionId) await this.createChat();
        const sid = this.activeSessionId!;
        const history = this.apiHistory.get(sid) ?? [];
        history.push({ role: 'user', content: message });
        const runId = sid;
        const model = this.selection.modelId;
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: sid });
        let full = '';
        this.apiAbort = new AbortController();
        try {
            await streamSse(`${this.apiBase}/v1/chat/completions`, {
                method: 'POST',
                headers: { ...this.apiHeaders(), 'content-type': 'application/json' },
                body: {
                    ...(model ? { model } : {}),
                    messages: history.map((m) => ({ role: m.role, content: m.content })),
                    stream: true,
                },
                signal: this.apiAbort.signal,
                timeoutMs: 0,
            }, (ev) => {
                const data = ev.data.trim();
                if (!data || data === '[DONE]') return;
                let parsed: any;
                try { parsed = JSON.parse(data); } catch { return; }
                captureBridgeDebug(this.id, 'native', {
                    operation: 'apiServer.sse',
                    sessionKey: sid,
                    runId,
                    payload: parsed,
                });
                const delta = parsed?.choices?.[0]?.delta || {};
                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                    this.emit('stream', { type: 'thinking_chunk', runId, sessionKey: sid, text: delta.reasoning_content });
                }
                if (typeof delta.content === 'string' && delta.content) {
                    full += delta.content;
                    this.emit('stream', { type: 'agent_message', runId, sessionKey: sid, text: full, delta: delta.content });
                }
            });
            history.push({ role: 'assistant', content: full });
            this.apiHistory.set(sid, history);
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey: sid });
        } catch (err) {
            Logger.getInstance().warn('Hermes API-server chat failed', err);
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey: sid });
        } finally {
            this.apiAbort = null;
        }
        return { session_id: sid };
    }

    async stopRun(sessionKey: string, runId?: string): Promise<void> {
        const key = sessionKey || this.activeSessionId || 'hermes';
        const id = runId || `hermes-stop-${Date.now()}`;
        if (this.apiMode) {
            this.apiAbort?.abort();
            this.apiAbort = null;
            this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: id, sessionKey: key });
            return;
        }
        if (!this.activeSessionId || !this.isConnected()) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: id, sessionKey: key });
            return;
        }
        const liveId = await this.resolveLiveSessionId(false);
        if (!liveId) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: id, sessionKey: key });
            return;
        }
        await this.request('session.interrupt', { session_id: liveId }, 10000).catch(() => undefined);
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: id, sessionKey: key });
    }

    async getUsage(): Promise<any> {
        if (this.apiMode || !this.activeSessionId || !this.isConnected()) return {};
        try {
            const liveId = await this.resolveLiveSessionId(false);
            if (!liveId) return {};
            return await this.request('session.usage', { session_id: liveId }, 10000);
        } catch (err) {
            Logger.getInstance().warn('Hermes usage failed', err);
            return {};
        }
    }

    async getContextUsage(sessionKey: string): Promise<{ percentUsed?: number; usedTokens?: number; contextWindow?: number } | null> {
        const previous = this.activeSessionId;
        this.activeSessionId = sessionKey || this.activeSessionId;
        try {
            const usage: any = await this.getUsage();
            const usedTokens = numberFromAny(usage?.contextTokens ?? usage?.context_tokens ?? usage?.total_tokens ?? ((usage?.inputTokens ?? usage?.input_tokens ?? 0) + (usage?.outputTokens ?? usage?.output_tokens ?? 0)));
            const contextWindow = numberFromAny(usage?.contextWindow ?? usage?.context_window ?? usage?.window ?? usage?.max_tokens);
            const percentUsed = usedTokens && contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : undefined;
            return usedTokens || contextWindow ? { usedTokens, contextWindow, percentUsed } : null;
        } finally {
            this.activeSessionId = previous;
        }
    }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        if (!sessionKey && !this.activeSessionId) return false;
        const previous = this.activeSessionId;
        this.activeSessionId = sessionKey || this.activeSessionId;
        try {
            const liveId = await this.resolveLiveSessionId(false);
            if (!liveId) return false;
            await this.request('session.steer', { session_id: liveId, text: message }, 120000);
            return true;
        } catch (err) {
            Logger.getInstance().warn('Hermes steer failed', err);
            return false;
        } finally {
            this.activeSessionId = previous;
        }
    }

    async injectHiddenContext(sessionKey: string, _context: BridgeContext, message: string): Promise<boolean> {
        return this.injectMessage(sessionKey, message);
    }

    canSteer(): boolean {
        return true;
    }

    canAdminInject(): boolean {
        return false;
    }

    /** Resolve a blocking approval prompt. The gateway keys approval.respond by
     *  session_id (FIFO across the session's pending queue), not request_id. */
    async respondApproval(data: { choice: string; all?: boolean }): Promise<void> {
        if (this.apiMode || !this.isConnected()) return;
        const choice = String(data.choice || 'deny');
        const liveId = await this.resolveLiveSessionId(false);
        if (!liveId) return;
        await this.request('approval.respond', { session_id: liveId, choice, all: !!data.all }, 30000)
            .catch((err) => Logger.getInstance().warn('Hermes approval.respond failed', err));
    }

    /** Resolve a blocking input prompt (secret / sudo / clarify / terminal-read).
     *  Each is its own RPC keyed by request_id with a method-specific field. */
    async respondInput(data: { requestId: string; kind: string; value: string }): Promise<void> {
        if (this.apiMode || !this.isConnected() || !data.requestId) return;
        const route: Record<string, { method: string; field: string }> = {
            secret: { method: 'secret.respond', field: 'value' },
            sudo: { method: 'sudo.respond', field: 'password' },
            clarify: { method: 'clarify.respond', field: 'answer' },
            'terminal.read': { method: 'terminal.read.respond', field: 'text' },
        };
        const target = route[data.kind];
        if (!target) return;
        await this.request(target.method, { request_id: data.requestId, [target.field]: data.value ?? '' }, 30000)
            .catch((err) => Logger.getInstance().warn(`Hermes ${target.method} failed`, err));
    }

    /** Manually compact the session context (Hermes session.compress). */
    async compactContext(_sessionKey: string): Promise<void> {
        if (this.apiMode || !this.isConnected()) return;
        const liveId = await this.resolveLiveSessionId(false);
        if (!liveId) return;
        await this.request('session.compress', { session_id: liveId }, 120000)
            .catch((err) => Logger.getInstance().warn('Hermes session.compress failed', err));
    }

    setSelection(selection: BridgeSelectionState): void {
        this.selection = { ...this.selection, ...selection };
    }

    getSelection(): BridgeSelectionState {
        const activeModel = this.activeSessionId ? this.knownSessions.get(this.activeSessionId)?.model : undefined;
        return { ...this.selection, ...(activeModel ? { modelId: activeModel } : {}) };
    }

    async applySandboxSelection(data: any): Promise<void> {
        if (this.apiMode || !this.activeSessionId || !this.isConnected()) return;
        const approvalMode = String(data.approvalMode ?? '').trim();
        if (!approvalMode) return;
        const liveId = await this.resolveLiveSessionId(false);
        if (!liveId) return;
        const yoloEnabled = this.yoloEnabledBySession.has(liveId);
        if (approvalMode === 'never' && !yoloEnabled) {
            await this.request('config.set', { session_id: liveId, key: 'yolo', value: 'on', scope: 'session' }, 30000);
            this.yoloEnabledBySession.add(liveId);
        } else if ((approvalMode === 'ask' || approvalMode === 'default') && yoloEnabled) {
            await this.request('config.set', { session_id: liveId, key: 'yolo', value: 'off', scope: 'session' }, 30000);
            this.yoloEnabledBySession.delete(liveId);
        }
    }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        return this.modelPicker.listModelChoices(selectedModel, selectedThinking);
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        return this.modelPicker.selectModelChoice(data);
    }

    private async applyReasoningSelection(sessionId: string): Promise<void> {
        const thinking = normalizeHermesThinking(this.selection.thinking);
        if (!thinking || this.reasoningAppliedBySession.get(sessionId) === thinking) return;
        await this.request('config.set', { session_id: sessionId, key: 'reasoning', value: thinking }, 30000);
        this.reasoningAppliedBySession.set(sessionId, thinking);
    }

    private async applyModelSelectionBeforeFirstPrompt(sessionId: string): Promise<void> {
        if (this.modelAppliedBySession.has(sessionId)) return;
        this.modelAppliedBySession.add(sessionId);
        const selected = parseHermesSelectedModel(this.getSelection().modelId);
        if (!selected?.model) return;
        const provider = selected.provider ? ` --provider ${quoteHermesArg(selected.provider)}` : '';
        await this.request('config.set', {
            session_id: sessionId,
            key: 'model',
            value: `${quoteHermesArg(selected.model)}${provider} --session`,
        }, 120000);
    }

    private async setSessionConfig(key: string, value: string): Promise<void> {
        if (this.apiMode || !this.activeSessionId || !this.isConnected()) return;
        const liveId = await this.resolveLiveSessionId(true);
        if (!liveId) return;
        await this.request('config.set', { session_id: liveId, key, value }, 120000);
        if (key === 'model') this.modelAppliedBySession.add(liveId);
    }

    private async executeHermesSlash(text: string): Promise<void> {
        if (this.apiMode || !this.isConnected()) return;
        const parsed = parseSlashCommand(text);
        if (!parsed) return;
        if (!this.activeSessionId) await this.createChat();
        const liveId = await this.resolveLiveSessionId(true);
        if (!liveId) return;
        const command = `${parsed.name}${parsed.args ? ` ${parsed.args}` : ''}`;
        const runId = slashRunId(this.id, parsed.name);
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: this.activeSessionId });
        try {
            let result: HermesSlashDispatch;
            try {
                result = await this.request<HermesSlashDispatch>('slash.exec', { session_id: liveId, command }, 120000);
            } catch {
                result = await this.request<HermesSlashDispatch>('command.dispatch', {
                    session_id: liveId,
                    name: parsed.name,
                    arg: parsed.args,
                }, 120000);
            }
            await this.handleHermesSlashResult(result, parsed.name, parsed.args, liveId, runId);
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey: this.activeSessionId });
        } catch (err) {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey: this.activeSessionId });
            throw err;
        }
    }

    private async handleHermesSlashResult(result: HermesSlashDispatch, name: string, args: string, liveId: string, runId: string): Promise<void> {
        if (!result || typeof result !== 'object') {
            this.emitHermesSlashText(runId, `/${name}: no output`);
            return;
        }
        if (result.type === 'alias' && result.target) {
            await this.executeHermesSlash(`/${result.target}${args ? ` ${args}` : ''}`);
            return;
        }
        if (result.type === 'send' || result.type === 'skill') {
            if (result.notice?.trim()) this.emitHermesSlashText(runId, result.notice.trim());
            if (result.message?.trim()) {
                await this.request('prompt.submit', { session_id: liveId, text: result.message.trim() }, 120000);
                return;
            }
            this.emitHermesSlashText(runId, `/${name}: empty message`);
            return;
        }
        if (result.type === 'prefill') {
            const lines = [result.notice, result.message && `Prefill: ${result.message}`].filter((line) => String(line || '').trim());
            this.emitHermesSlashText(runId, lines.join('\n') || `/${name}: no output`);
            return;
        }
        const body = result.output || `/${name}: no output`;
        const text = result.warning ? `warning: ${result.warning}\n${body}` : body;
        const commandOutput = parseHermesCommandOutput(`/${name}${args ? ` ${args}` : ''}`, text);
        this.emitHermesSlashText(runId, commandOutput ? commandOutputToMarkdown(commandOutput) : text, commandOutput);
    }

    private emitHermesSlashText(runId: string, text: string, commandOutput?: any): void {
        if (!this.activeSessionId) return;
        this.emit('stream', {
            type: 'agent_message',
            runId,
            sessionKey: this.activeSessionId,
            text,
            ...(commandOutput ? { commandOutput } : {}),
        });
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        // API-server transport active: report the gateway's OpenAI-compatible runtime.
        if (this.apiMode && this.apiConnected) {
            return [
                {
                    id: 'hermes:apiserver',
                    label: `hermling@api:${portFromUrl(this.apiBase) || '8642'}`,
                    description: 'Gateway API server (OpenAI-compatible)',
                    section: 'Hermes',
                    icon: 'hubot',
                    checked: true,
                },
                {
                    id: 'hermes:settings',
                    label: 'Configure Hermes…',
                    description: 'Bridge settings',
                    section: 'Hermes',
                    icon: 'gear',
                },
            ];
        }
        const available = await textRequest(getHermesBaseUrl(), { timeoutMs: 250 }).then((html) => html.includes('__HERMES_SESSION_TOKEN__')).catch(() => false);
        const port = portFromUrl(getHermesBaseUrl());
        if (!available) {
            return [
                {
                    id: 'hermes:autodetect',
                    label: 'Set Hermes path…',
                    description: 'Configure Hermes connection manually',
                    section: 'Hermes',
                    icon: 'gear',
                    setup: true,
                },
                {
                    id: 'hermes:settings',
                    label: 'Configure Hermes…',
                    description: 'Bridge settings',
                    section: 'Hermes',
                    icon: 'gear',
                    setup: true,
                },
            ];
        }
        return [
            {
                id: 'hermes:managed',
                label: `hermling@hermes:${port}`,
                description: 'Detected dashboard runtime',
                section: 'Hermes',
                icon: 'hubot',
                checked: true,
            },
            {
                id: 'hermes:settings',
                label: 'Configure Hermes…',
                description: 'Bridge settings',
                section: 'Hermes',
                icon: 'gear',
            },
        ];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        const id = String(data.id ?? '');
        if (id === 'hermes:settings' || id === 'hermes:autodetect') { await this.configure(); return; }
    }

    getEnvironmentLabel(): string {
        const home = getHermesHome();
        const dirName = path.basename(home);
        // Strip common prefixes: ~/.hermes-hermling → hermling
        const match = dirName.match(/^hermes[_-]?(.+)/);
        return match ? match[1] : dirName;
    }

    async getSlashSuggestions(prefix: string): Promise<Array<{ name: string; description?: string }>> {
        if (!this.apiMode && this.isConnected()) {
            try {
                const res = await this.request<{ pairs?: any[]; categories?: any[] }>('commands.catalog', {}, 10000);
                const pairs = Array.isArray(res?.pairs) ? res.pairs : [];
                const items = pairs.map((pair) => {
                    if (Array.isArray(pair)) return { name: String(pair[0] ?? '').replace(/^\//, ''), description: String(pair[1] ?? '') };
                    return { name: String(pair?.name ?? '').replace(/^\//, ''), description: String(pair?.description ?? '') };
                }).filter((item) => item.name);
                const p = prefix.replace(/^\//, '');
                return items.filter((item) => item.name.startsWith(p));
            } catch (err) {
                Logger.getInstance().warn('Hermes commands.catalog failed', err);
            }
        }
        const base = [
            { name: 'new', description: 'Start a new session (fresh session ID + history)' },
            { name: 'model', description: 'Switch model for this session' },
            { name: 'reasoning', description: 'Manage reasoning effort and display' },
            { name: 'compress', description: 'Manually compress conversation context' },
            { name: 'history', description: 'Show conversation history' },
            { name: 'retry', description: 'Retry the last message' },
            { name: 'undo', description: 'Remove the last user/assistant exchange' },
            { name: 'branch', description: 'Branch the current session' },
            { name: 'handoff', description: 'Hand off this session to a messaging platform' },
            { name: 'steer', description: 'Inject a message after the next tool call without interrupting' },
            { name: 'queue', description: "Queue a prompt for the next turn (doesn't interrupt)" },
            { name: 'goal', description: 'Set a standing goal across turns' },
            { name: 'agents', description: 'Show active agents and running tasks' },
            { name: 'stop', description: 'Kill all running background processes' },
            { name: 'sessions', description: 'Browse and resume previous sessions' },
            { name: 'resume', description: 'Resume a previously-named session' },
            { name: 'save', description: 'Save the current conversation' },
            { name: 'title', description: 'Set a title for the current session' },
            { name: 'tools', description: 'Manage tools: list / enable / disable' },
            { name: 'skills', description: 'Search, install, inspect, or manage skills' },
            { name: 'fast', description: 'Toggle fast mode' },
            { name: 'yolo', description: 'Toggle YOLO mode (skip approvals)' },
            { name: 'verbose', description: 'Cycle tool progress display' },
            { name: 'config', description: 'Show current configuration' },
            { name: 'status', description: 'Show session info' },
            { name: 'commands', description: 'Browse all commands and skills (paginated)' },
            { name: 'help', description: 'Show available commands' },
        ];
        const p = prefix.replace(/^\//, '');
        return base.filter((item) => item.name.startsWith(p));
    }

    getToolStatus(): ToolStatusView | null {
        return null;
    }

    private async ensureConnected(): Promise<void> {
        if (!this.isConnected()) {
            const ok = await this.connect();
            if (!ok) throw new Error('Hermes bridge is not connected');
        }
    }

    private async connectWs(): Promise<void> {
        const token = await this.getDashboardToken();
        const wsUrl = new URL(getHermesWsUrl());
        wsUrl.searchParams.set('token', token);
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(wsUrl.toString());
            this.ws = ws;
            ws.on('open', resolve);
            ws.on('error', reject);
            ws.on('close', () => {
                this.emit('disconnected');
                for (const p of this.pending.values()) {
                    clearTimeout(p.timer);
                    p.reject(new Error('Hermes WebSocket closed'));
                }
                this.pending.clear();
            });
            ws.on('message', (data) => this.handleWsMessage(data.toString()));
        });
    }

    private async getDashboardToken(): Promise<string> {
        const html = await textRequest(getHermesBaseUrl(), { timeoutMs: 5000 });
        const match = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
        if (!match) throw new Error('Hermes dashboard token not found; start dashboard with --tui on loopback');
        return match[1];
    }

    private request<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Hermes WebSocket is not open'));
        }
        const id = `vscode-${++this.requestId}`;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`Hermes request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
    }

    private handleWsMessage(raw: string): void {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
            const pending = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.error) {
                const code = msg.error.code !== undefined ? ` ${msg.error.code}` : '';
                const message = msg.error.message || 'Hermes request failed';
                pending.reject(new Error(`Hermes ${pending.method}${code}: ${message}`));
            }
            else pending.resolve(msg.result);
            return;
        }
        if (msg.method !== 'event') return;
        const ev = msg.params || {};
        this.mapEvent(ev);
    }

    private async resolveLiveSessionId(createIfMissing: boolean): Promise<string | null> {
        if (!this.activeSessionId) {
            if (!createIfMissing) return null;
            await this.createChat();
        }
        const key = this.activeSessionId!;
        const live = await this.findLiveSession(key);
        if (live?.id) {
            this.rememberLiveSession(live.session_key || key, live.id);
            if (live.session_key && live.session_key !== this.activeSessionId) {
                this.activeSessionId = live.session_key;
                this.persistSessions();
            }
            return live.id;
        }

        try {
            const resumed = await this.request<{
                session_id?: string;
                session_key?: string;
                resumed?: string;
                info?: { title?: string; model?: string };
            }>('session.resume', { session_id: key, source: 'vscode' }, 120000);
            const liveId = resumed?.session_id;
            if (liveId) {
                const storedKey = resumed.session_key || resumed.resumed || key;
                this.rememberLiveSession(storedKey, liveId);
                this.activeSessionId = storedKey;
                const known = this.knownSessions.get(storedKey) ?? { title: resumed.info?.title || storedKey };
                if (resumed.info?.model) known.model = resumed.info.model;
                this.knownSessions.set(storedKey, known);
                this.persistSessions();
                return liveId;
            }
        } catch (err) {
            if (!createIfMissing || !String((err as Error).message || '').includes('session not found')) {
                throw err;
            }
        }

        if (!createIfMissing) return null;
        const createdKey = await this.createChat();
        return this.liveSessionByKey.get(createdKey) || createdKey;
    }

    private async findLiveSession(key: string): Promise<HermesLiveSession | null> {
        const cached = this.liveSessionByKey.get(key);
        const current = cached || key;
        const res = await this.request<{ sessions?: HermesLiveSession[] }>(
            'session.active_list',
            { current_session_id: current },
            10000,
        ).catch(() => ({ sessions: [] }));
        const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
        const found = sessions.find((s) => s.id === key || s.id === cached || s.session_key === key || s.session_key === cached);
        if (found?.id) {
            this.rememberLiveSession(found.session_key || key, found.id);
            if (found.session_key) {
                const known = this.knownSessions.get(found.session_key) ?? { title: found.title || found.session_key };
                if (found.title) known.title = found.title;
                if (found.model) known.model = found.model;
                this.knownSessions.set(found.session_key, known);
            }
        }
        return found ?? null;
    }

    private rememberLiveSession(key: string, liveId: string): void {
        if (!key || !liveId) return;
        this.liveSessionByKey.set(key, liveId);
        this.sessionKeyByLive.set(liveId, key);
        this.liveSessionByKey.set(liveId, liveId);
    }

    private possibleStoredSessionKeys(sessionKey: string): string[] {
        return Array.from(new Set([
            this.sessionKeyByLive.get(sessionKey),
            sessionKey,
            this.activeSessionId ? this.sessionKeyByLive.get(this.activeSessionId) : undefined,
        ].filter((value): value is string => !!value)));
    }

    private async listSessionsViaHermes(includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[] | null> {
        await this.ensureConnected();
        const res = await this.request<{ sessions?: any[] }>('session.list', { limit: 200 }, 10000);
        const rows = Array.isArray(res?.sessions) ? res.sessions : [];
        return rows
            .map((row): BridgeSession | null => {
                const key = String(row?.id ?? row?.session_key ?? '');
                if (!key) return null;
                const local = this.knownSessions.get(key);
                const isArchived = archivedKeys.has(key) || !!row.archived;
                if (!includeArchived && isArchived) return null;
                return {
                    key,
                    title: String(row?.title || local?.title || key),
                    model: row?.model || local?.model,
                    isActive: key === this.activeSessionId,
                    isArchived,
                    groupId: 'recent',
                    groupLabel: 'Recent',
                    workspaceUri: typeof row?.cwd === 'string' ? row.cwd : undefined,
                } satisfies BridgeSession;
            })
            .filter((item): item is BridgeSession => item !== null);
    }

    private async listSessionsFromStateDb(includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[] | null> {
        const dbPath = path.join(getHermesHome(), 'state.db');
        if (!existsSync(dbPath)) return null;
        const rows = await this.sqliteJson(dbPath, 'select id, title, model, archived, started_at, message_count, cwd from sessions order by started_at desc limit 200');
        return rows
            .map((row): BridgeSession | null => {
                const key = String(row?.id ?? '');
                if (!key) return null;
                const local = this.knownSessions.get(key);
                const isArchived = archivedKeys.has(key) || !!row.archived;
                if (!includeArchived && isArchived) return null;
                return {
                    key,
                    title: String(row?.title || local?.title || key),
                    model: row?.model || local?.model,
                    isActive: key === this.activeSessionId,
                    isArchived,
                    groupId: 'recent',
                    groupLabel: 'Recent',
                    workspaceUri: typeof row?.cwd === 'string' ? row.cwd : undefined,
                    messageCount: typeof row?.message_count === 'number' ? row.message_count : undefined,
                    lastActiveTs: typeof row?.started_at === 'number' ? Math.round(row.started_at * 1000) : undefined,
                } satisfies BridgeSession;
            })
            .filter((item): item is BridgeSession => item !== null);
    }

    private async sqliteJson(dbPath: string, sql: string): Promise<any[]> {
        const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], { maxBuffer: 50 * 1024 * 1024 });
        const text = String(stdout || '').trim();
        if (!text) return [];
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    }

    private mapEvent(ev: any): void {
        const liveId = ev.session_id || this.activeSessionId || 'hermes';
        const sessionId = this.sessionKeyByLive.get(liveId) || liveId;
        captureBridgeDebug(this.id, 'native', {
            operation: 'websocket.event',
            sessionKey: sessionId,
            liveId,
            event: ev,
        });
        const mapped = mapHermesWsEvent({ ...ev, session_id: sessionId }, this.activeSessionId, this.buffers.get(sessionId) || '');
        captureBridgeDebug(this.id, 'normalized', {
            operation: 'websocket.event',
            sessionKey: sessionId,
            liveId,
            eventType: ev?.type,
            mapped,
        });
        if (mapped.nextText !== undefined) this.buffers.set(sessionId, mapped.nextText);
        if (mapped.clearBuffer) this.buffers.delete(mapped.runId);
        for (const event of mapped.events) {
            // session_meta is gateway-pushed session state — fold it into the
            // local session cache rather than forwarding it to the transcript.
            if (event.type === 'session_meta') {
                const known: { title: string; model?: string } = this.knownSessions.get(sessionId) ?? { title: sessionId };
                if (typeof event.model === 'string' && event.model) known.model = event.model;
                if (typeof event.title === 'string' && event.title) known.title = event.title;
                this.knownSessions.set(sessionId, known);
                this.persistSessions();
                continue;
            }
            this.emit('stream', { sessionKey: sessionId, ...event });
        }
    }

    private async ensureManagedRuntime(): Promise<void> {
        // Always sync apiBaseUrl from config (API server port may differ from dashboard port)
        const apiCfg = await readHermesApiConfig();
        if (apiCfg.apiPort) {
            const apiUrl = `http://${apiCfg.apiHost ?? '127.0.0.1'}:${apiCfg.apiPort}`;
            if (apiUrl !== getHermesApiBaseUrl()) {
                await updateHermesRuntime({ apiBaseUrl: apiUrl });
            }
        }
        try {
            await textRequest(getHermesBaseUrl(), { timeoutMs: 1000 });
            return;
        } catch {}
        // Configured dashboard URL unreachable — scan known dashboard ports before spawning
        const detected = await hermesAutoDetect(300);
        if (detected) {
            const u = new URL(detected);
            await updateHermesRuntime({
                dashboardUrl: detected,
                wsUrl: `ws://${u.host}/api/ws`,
            });
            return;
        }
        this.spawnDashboard();
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                await textRequest(getHermesBaseUrl(), { timeoutMs: 1000 });
                return;
            } catch {}
        }
    }

    private spawnDashboard(): void {
        const repo = hermesConfig().get<string>('repoPath', '');
        const home = getHermesHome();
        const logDir = path.join(home, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const out = fs.openSync(path.join(logDir, 'dashboard.log'), 'a');
        const dashArgs = ['dashboard', '--host', '127.0.0.1', '--port', '9119', '--no-open', '--tui', '--skip-build'];
        const env = { ...process.env, HERMES_HOME: home, HERMES_DASHBOARD_TUI: '1' };

        // Prefer a built `hermes` CLI — an explicit cliPath, the repo's own venv
        // (setup-hermes.sh installs to venv/bin/hermes), or one on PATH (e.g.
        // ~/bin/hermes). This uses the user's installed build directly instead of
        // resolving a fresh uv environment on every spawn.
        const venvBin = repo ? path.join(repo, 'venv', 'bin', 'hermes') : '';
        const cliPath = hermesConfig().get<string>('cliPath', '')
            || (venvBin && existsSync(venvBin) ? venvBin : '')
            || findOnPath('hermes');
        if (cliPath) {
            spawn(cliPath, dashArgs, {
                cwd: repo || home,
                detached: true,
                stdio: ['ignore', out, out],
                env,
            }).unref();
            return;
        }

        // Fallback: run from the repo source via uv (or bare python).
        if (!repo || !fs.existsSync(repo)) return;
        const uv = findOnPath('uv');
        const command = uv || process.env.PYTHON || 'python';
        const args = (uv ? ['run', '--locked', '--extra', 'web', 'python'] : [])
            .concat(['-m', 'hermes_cli.main'], dashArgs);
        const child = spawn(command, args, {
            cwd: repo,
            detached: true,
            stdio: ['ignore', out, out],
            env: { ...env, PYTHONPATH: repo },
        });
        child.unref();
    }
}

function findOnPath(binary: string): string | null {
    const paths = (process.env.PATH || '').split(path.delimiter);
    for (const dir of paths) {
        const candidate = path.join(dir, binary);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function portFromUrl(value: string): string {
    try { return new URL(value).port || ''; } catch { return ''; }
}

function normalizeHermesThinking(value?: string): string | undefined {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return undefined;
    if (raw === 'off') return 'none';
    return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(raw) ? raw : undefined;
}

function parseHermesSelectedModel(modelId?: string): { provider: string; model: string } | null {
    const raw = String(modelId ?? '').trim().replace(/:thinking:.*$/, '');
    if (!raw) return null;
    const slash = raw.indexOf('/');
    if (slash <= 0) return { provider: '', model: raw };
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

function quoteHermesArg(value: string): string {
    if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) return value;
    return JSON.stringify(value);
}

function numberFromAny(value: any): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseJsonLoose(value: any): any {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (!/^[\[{"]/.test(trimmed) && !/^(true|false|null|-?\d)/.test(trimmed)) return value;
    try { return JSON.parse(trimmed); } catch { return value; }
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

interface HermesApiConfig {
    apiHost?: string;
    apiPort?: number;
    apiKey?: string;
    enabled?: boolean;
}

async function readHermesApiConfig(): Promise<HermesApiConfig> {
    const home = getHermesHome();
    for (const name of ['config.yaml', 'config.json', 'config.toml']) {
        try {
            const text = await fs.promises.readFile(path.join(home, name), 'utf-8');
            // Match platforms.api_server block — read host/port/key AFTER the
            // api_server: header to avoid grabbing fields from unrelated sections.
            const apiSection = text.match(/api_server:([\s\S]*?)(?=\n\S|\n\n[a-z]|$)/)?.[1] ?? '';
            const portMatch = apiSection.match(/\bport:\s*(\d+)/);
            const hostMatch = apiSection.match(/\bhost:\s*["']?([\d.a-z-]+)["']?/);
            const keyMatch = apiSection.match(/\bkey:\s*["']?([^"'\s]+)["']?/);
            const enabledMatch = apiSection.match(/\benabled:\s*(true|false)/i);
            if (portMatch) {
                return {
                    apiPort: parseInt(portMatch[1], 10),
                    apiHost: hostMatch?.[1] ?? '127.0.0.1',
                    apiKey: keyMatch?.[1],
                    enabled: enabledMatch ? /true/i.test(enabledMatch[1]) : true,
                };
            }
        } catch { /* file absent or unreadable */ }
    }
    // Fall back to .env (API_SERVER_PORT / API_SERVER_KEY) used by the gateway.
    try {
        const env = await fs.promises.readFile(path.join(home, '.env'), 'utf-8');
        const port = env.match(/^API_SERVER_PORT=(\d+)/m)?.[1];
        const key = env.match(/^API_SERVER_KEY=(.+)$/m)?.[1]?.trim();
        if (port) return { apiPort: parseInt(port, 10), apiHost: '127.0.0.1', apiKey: key, enabled: true };
    } catch { /* no .env */ }
    return {};
}

/** Read ~/.hermes-hermling/gateway_state.json (the running-gateway lockfile). */
async function readHermesGatewayState(): Promise<{ pid?: number; running: boolean; apiServerConnected: boolean }> {
    try {
        const raw = await fs.promises.readFile(path.join(getHermesHome(), 'gateway_state.json'), 'utf-8');
        const s = JSON.parse(raw);
        const pid: number | undefined = s?.pid;
        const alive = !!pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        return {
            pid,
            running: alive && s?.gateway_state === 'running',
            apiServerConnected: s?.platforms?.api_server?.state === 'connected',
        };
    } catch { return { running: false, apiServerConnected: false }; }
}

async function hermesAutoDetect(timeoutMs = 200): Promise<string | null> {
    // Only scan ports that serve the Hermes dashboard HTML (with __HERMES_SESSION_TOKEN__).
    // The API server port (from config) is a separate REST endpoint — do not include it here.
    const ports = [9119, 9120, 9000, 8000];
    const results = await Promise.all(ports.map(async (port) => {
        const url = `http://127.0.0.1:${port}`;
        try {
            const html = await textRequest(url, { timeoutMs });
            return html.includes('__HERMES_SESSION_TOKEN__') ? url : null;
        } catch {
            return null;
        }
    }));
    return results.find((r) => r !== null) ?? null;
}
