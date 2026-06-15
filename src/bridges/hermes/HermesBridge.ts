import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { getHermesApiBaseUrl, getHermesBaseUrl, getHermesHome, getHermesWsUrl, hermesConfig, updateHermesRuntime } from '../../config/agentBridgeConfig';
import { jsonRequest, textRequest } from '../http';
import { BridgeCapabilities, BridgeContext, BridgeSelectionState, BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, ModelChoice, OPENCLAW_THINKING_LEVELS, ToolStatusView } from '../types';
import { Logger } from '../../utils/logger';
import { mapHermesWsEvent } from './events';

interface Pending {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class HermesBridge extends EventEmitter implements ChatBridge {
    readonly id = 'hermes';
    readonly label = 'Hermes';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: false,
        steering: true,
        usage: false,
        tools: true,
    };

    private ws: WebSocket | null = null;
    private pending = new Map<string, Pending>();
    private requestId = 0;
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string; model?: string }>();
    private buffers = new Map<string, string>();

    constructor(readonly context: vscode.ExtensionContext) {
        super();
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
        try {
            await this.ensureManagedRuntime();
            await this.connectWs();
            this.emit('connected');
            return true;
        } catch (err) {
            Logger.getInstance().warn('Hermes bridge connect failed', err);
            this.emit('disconnected');
            return false;
        }
    }

    disconnect(): void {
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

    getSettingsQuery(): string {
        return 'junction.hermes';
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

    async createChat(): Promise<string> {
        await this.ensureConnected();
        const title = `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
        const res = await this.request<{ session_id?: string; session?: { id?: string } }>('session.create', { title });
        const key = res?.session_id || res?.session?.id || `hermes-${Date.now()}`;
        this.activeSessionId = key;
        this.knownSessions.set(key, { title });
        this.persistSessions();
        return key;
    }

    async listSessions(_scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
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
        const existing = this.knownSessions.get(key) ?? { title: label };
        existing.title = label;
        this.knownSessions.set(key, existing);
        this.persistSessions();
    }

    async getSessionHistory(): Promise<any> {
        if (!this.activeSessionId || !this.isConnected()) return { messages: [] };
        try {
            const res = await this.request<{ count?: number; messages?: any[] }>(
                'session.history',
                { session_id: this.activeSessionId },
                10000,
            );
            const rawMessages = Array.isArray(res?.messages) ? res.messages : [];
            const messages: any[] = [];
            for (const msg of rawMessages) {
                if (!msg) continue;
                const role = msg.role;
                if (role === 'user') {
                    messages.push({ role, content: msg.text || '' });
                } else if (role === 'assistant') {
                    // Convert {role, text} → {role, content: [{type: 'text', text}]}
                    const content: any[] = [];
                    if (msg.text) content.push({ type: 'text', text: msg.text });
                    if (content.length > 0) messages.push({ role, content });
                }
                // Skip tool/system messages — rebuildTurnsFromGatewayHistory handles those differently
            }
            return { messages };
        } catch (err) {
            Logger.getInstance().warn('Failed to fetch Hermes session history', err);
            return { messages: [] };
        }
    }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        await this.ensureConnected();
        if (!this.activeSessionId) await this.createChat();
        const session_id = this.activeSessionId!;
        const text = context?.workspace ? `[Workspace: ${context.workspace}]\n${message}` : message;
        await this.request('prompt.submit', { session_id, text }, 120000);
        return { session_id };
    }

    async stopRun(_sessionKey: string, _runId?: string): Promise<void> {
        if (!this.activeSessionId || !this.isConnected()) return;
        await this.request('session.interrupt', { session_id: this.activeSessionId }, 10000).catch(() => undefined);
    }

    async getUsage(): Promise<any> {
        return {};
    }

    async injectMessage(_sessionKey: string, message: string): Promise<boolean> {
        if (!this.activeSessionId) return false;
        try {
            await this.request('prompt.submit', { session_id: this.activeSessionId, text: `/steer ${message}` }, 120000);
            return true;
        } catch (err) {
            Logger.getInstance().warn('Hermes steer failed', err);
            return false;
        }
    }

    canSteer(): boolean {
        return true;
    }

    canAdminInject(): boolean {
        return false;
    }

    setSelection(selection: BridgeSelectionState): void {
        this.selection = { ...this.selection, ...selection };
    }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        await this.ensureConnected();
        const payload = await this.request<any>('model.options', { session_id: this.activeSessionId || '' }, 30000);
        const providers = Array.isArray(payload?.providers) ? payload.providers : [];
        const choices: ModelChoice[] = [];
        for (const provider of providers) {
            const slug = String(provider.slug || provider.id || provider.name || '');
            const models = Array.isArray(provider.models) ? provider.models : [];
            for (const raw of models) {
                const model = typeof raw === 'string' ? raw : String(raw.id || raw.model || raw.name || '');
                if (!model) continue;
                const id = slug ? `${slug}/${model}` : model;
                // Per-model reasoning vocabulary from the Hermes payload — the
                // model's own efforts, never a generic union. Hide the submenu
                // when the API advertises none.
                const efforts = reasoningEffortsFromRaw(raw);
                const supportsReasoning = (raw?.supports_reasoning ?? raw?.supportsReasoning ?? false) || efforts.length > 0;
                // Named per-model efforts when advertised; else OpenClaw's canonical
                // levels for any reasoning model — so the submenu is never empty.
                const levels = efforts.length ? efforts : (supportsReasoning ? OPENCLAW_THINKING_LEVELS : []);
                choices.push({
                    id,
                    label: raw?.label || raw?.name || model,
                    description: [provider.name || slug, supportsReasoning ? 'reasoning' : ''].filter(Boolean).join(' · '),
                    provider: slug,
                    model,
                    supportsReasoning,
                    icon: supportsReasoning ? 'lightbulb' : 'symbol-method',
                    checked: selectedModel === id || selectedModel === model,
                    children: levels.length ? levels.map((level) => ({
                        id: `${id}:thinking:${level}`,
                        label: level,
                        icon: 'thinking',
                        thinking: level,
                        checked: (selectedModel === id || selectedModel === model) && selectedThinking === level,
                    })) : undefined,
                });
            }
        }
        if (!choices.length) {
            choices.push({ id: 'hermes-agent', label: 'hermes-agent', model: 'hermes-agent', icon: 'symbol-method', checked: !selectedModel });
        }
        return choices;
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const provider = String(data.provider ?? '');
        const model = String(data.model ?? data.id ?? '').replace(/^.*:/, '');
        if (!model) return null;
        const modelId = provider ? `${provider}/${model}` : model;
        const thinking = data.thinking !== undefined ? String(data.thinking) : this.selection.thinking;
        this.setSelection({ modelId, thinking });
        if (this.activeSessionId) {
            const known = this.knownSessions.get(this.activeSessionId) ?? { title: this.activeSessionId };
            known.model = modelId;
            this.knownSessions.set(this.activeSessionId, known);
            this.persistSessions();
        }
        return { display: String(data.label ?? model), modelId, thinking };
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
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

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const base = [
            { name: 'compact', description: 'Toggle compact display mode' },
            { name: 'details', description: 'Control agent details' },
            { name: 'logs', description: 'Show recent logs' },
        ];
        return base.filter((item) => item.name.startsWith(prefix));
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
            this.pending.set(id, { resolve, reject, timer });
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
            if (msg.error) pending.reject(new Error(msg.error.message || 'Hermes request failed'));
            else pending.resolve(msg.result);
            return;
        }
        if (msg.method !== 'event') return;
        const ev = msg.params || {};
        this.mapEvent(ev);
    }

    private mapEvent(ev: any): void {
        const sessionId = ev.session_id || this.activeSessionId || 'hermes';
        const mapped = mapHermesWsEvent(ev, this.activeSessionId, this.buffers.get(sessionId) || '');
        if (mapped.nextText !== undefined) this.buffers.set(mapped.runId, mapped.nextText);
        if (mapped.clearBuffer) this.buffers.delete(mapped.runId);
        for (const event of mapped.events) this.emit('stream', event);
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
        if (!repo || !fs.existsSync(repo)) return;
        const home = getHermesHome();
        const logDir = path.join(home, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const out = fs.openSync(path.join(logDir, 'dashboard.log'), 'a');
        const uv = findOnPath('uv');
        const command = uv || process.env.PYTHON || 'python';
        const args = uv ? [
            'run',
            '--locked',
            '--extra',
            'web',
            'python',
            '-m',
            'hermes_cli.main',
            'dashboard',
            '--host', '127.0.0.1',
            '--port', '9119',
            '--no-open',
            '--tui',
            '--skip-build',
        ] : [
            '-m',
            'hermes_cli.main',
            'dashboard',
            '--host', '127.0.0.1',
            '--port', '9119',
            '--no-open',
            '--tui',
            '--skip-build',
        ];
        const child = spawn(command, args, {
            cwd: repo,
            detached: true,
            stdio: ['ignore', out, out],
            env: {
                ...process.env,
                HERMES_HOME: home,
                HERMES_DASHBOARD_TUI: '1',
                PYTHONPATH: repo,
            },
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

/**
 * Extract a Hermes model's own reasoning vocabulary from its raw payload.
 * Returns the model's advertised efforts (its lingua franca) or [] — never a
 * fabricated generic union. Accepts arrays of strings or {id}, under any of the
 * common field names Hermes may use.
 */
function reasoningEffortsFromRaw(raw: any): string[] {
    if (!raw || typeof raw !== 'object') return [];
    const source =
        raw.supported_reasoning_efforts ?? raw.supportedReasoningEfforts ??
        raw.reasoning_efforts ?? raw.reasoning_levels ?? raw.reasoningLevels ??
        raw.thinking_levels ?? raw.thinkingLevels ?? raw.thinking_options ?? raw.thinkingOptions;
    if (!Array.isArray(source)) return [];
    return source
        .map((e) => (typeof e === 'string' ? e : typeof e?.id === 'string' ? e.id : ''))
        .filter((e): e is string => !!e);
}

interface HermesApiConfig {
    apiHost?: string;
    apiPort?: number;
}

async function readHermesApiConfig(): Promise<HermesApiConfig> {
    const home = getHermesHome();
    for (const name of ['config.yaml', 'config.json', 'config.toml']) {
        try {
            const text = await fs.promises.readFile(path.join(home, name), 'utf-8');
            // Match platforms.api_server.extra block — look for host/port AFTER api_server: header
            // to avoid grabbing ports from unrelated sections (ollama, etc.)
            const apiSection = text.match(/api_server:([\s\S]*?)(?=\n\S|\n\n[a-z]|$)/)?.[1] ?? '';
            const portMatch = apiSection.match(/\bport:\s*(\d+)/);
            const hostMatch = apiSection.match(/\bhost:\s*["']?([\d.a-z-]+)["']?/);
            if (portMatch) {
                return {
                    apiPort: parseInt(portMatch[1], 10),
                    apiHost: hostMatch?.[1] ?? '127.0.0.1',
                };
            }
        } catch { /* file absent or unreadable */ }
    }
    return {};
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
