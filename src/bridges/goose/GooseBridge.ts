import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, streamSse, textRequest } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChoiceMenuItem, HistoryMessage,
    ModelChoice, ToolStatusView, OPENCLAW_THINKING_LEVELS,
} from '../types';
import { Logger } from '../../utils/logger';
import { mapGooseSseEvent, GooseMapperState } from './events';

function gooseConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.goose');
}

function gooseSecretKey(): string {
    return (gooseConfig().get<string>('secretKey') || '').trim();
}

/** goosed routes accept an optional X-Secret-Key; harmless when unset/ACP. */
function gooseHeaders(): Record<string, string> {
    const key = gooseSecretKey();
    return key ? { 'x-secret-key': key } : {};
}

function gooseHome(): string {
    const raw = gooseConfig().get<string>('home') || '';
    if (raw) {
        if (raw === '~' || raw === '~/') return process.env.HOME || raw;
        if (raw.startsWith('~/')) return path.join(process.env.HOME || '~', raw.slice(2));
        return raw;
    }
    const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
    const dataDir = path.join(xdgData, 'goose');
    try { fs.accessSync(dataDir); return dataDir; } catch {}
    return path.join(process.env.HOME || '~', '.goose');
}

function gooseBinaryPath(): string {
    const configured = gooseConfig().get<string>('binaryPath');
    if (configured) return configured;
    try {
        const { execSync } = require('child_process');
        const resolved = execSync('which goose 2>/dev/null', { encoding: 'utf8' }).trim();
        if (resolved) return resolved;
    } catch {}
    return 'goose';
}

function gooseServerUrl(): string {
    return (gooseConfig().get<string>('serverUrl') || '').trim();
}

export class GooseBridge extends EventEmitter implements ChatBridge {
    readonly id = 'goose';
    readonly label = 'Goose';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: false,
        steering: false,
        usage: false,
        tools: true,
    };

    private process: ChildProcess | null = null;
    private baseUrl: string = '';
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, { title: string }>();
    private mapperState: GooseMapperState = { reasoningParts: new Set(), textAccum: new Map() };
    private commandCache: Array<{ name: string; description?: string }> = [];

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, { title: string }]>>('junction.goose.knownSessions');
        if (saved) this.knownSessions = new Map(saved);
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.goose.activeSessionId', null);
    }

    private persistSessions(): void {
        const data = Array.from(this.knownSessions.entries());
        this.context.workspaceState.update('junction.goose.knownSessions', data);
        this.context.workspaceState.update('junction.goose.activeSessionId', this.activeSessionId);
    }

    async connect(): Promise<boolean> {
        if (this.isConnected()) return true;

        const explicitUrl = gooseServerUrl();
        if (explicitUrl) {
            this.baseUrl = explicitUrl;
        } else {
            this.baseUrl = await gooseAutoDetect(500) ?? '';
        }

        if (!this.baseUrl) {
            this.emit('disconnected');
            return false;
        }

        this.loadCommands().catch(() => {});
        this.emit('connected');
        return true;
    }

    private async loadCommands(): Promise<void> {
        try {
            const wd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const url = `${this.baseUrl}/config/slash_commands` + (wd ? `?working_dir=${encodeURIComponent(wd)}` : '');
            const res: any = await jsonRequest(url, { headers: gooseHeaders(), timeoutMs: 3000 });
            const cmds: any[] = res?.commands || [];
            this.commandCache = cmds.map((c) => ({ name: String(c.command || '').replace(/^\//, ''), description: c.help }));
        } catch { /* ACP server or unavailable; leave cache empty */ }
    }

    disconnect(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.baseUrl = '';
        this.emit('disconnected');
    }

    isConnected(): boolean {
        return !!this.baseUrl;
    }

    async initializeWorkspace(): Promise<void> {}

    async registerRuntimeIntegrations(): Promise<void> {}

    async configure(): Promise<void> {
        vscode.commands.executeCommand('junction.openSettings');
    }

    getSettingsQuery(): string { return 'junction.goose'; }

    setPendingFileContext(context: string): void { this.pendingFileContext = context; }
    getPendingFileContext(): string | null {
        const ctx = this.pendingFileContext;
        this.pendingFileContext = null;
        return ctx;
    }

    getCurrentSessionKey(_folderUri?: vscode.Uri): string | null {
        return this.activeSessionId;
    }

    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> { return new Map(); }

    setActiveSession(_folderUri: vscode.Uri, key: string): void {
        this.activeSessionId = key;
        this.persistSessions();
    }

    async createChat(_folderUri?: vscode.Uri): Promise<string> {
        try {
            const res: any = await jsonRequest(`${this.baseUrl}/v1/sessions`, { method: 'POST', headers: gooseHeaders(), body: {} });
            const id = res?.id || res?.session_id || `goose-${Date.now()}`;
            this.activeSessionId = id;
            this.knownSessions.set(id, { title: 'New chat' });
            this.persistSessions();
            return id;
        } catch (err) {
            Logger.getInstance().error('Goose createChat failed', err);
            return `goose-${Date.now()}`;
        }
    }

    async listSessions(): Promise<BridgeSession[]> {
        return Array.from(this.knownSessions.entries()).map(([key, val]) => ({
            key,
            title: val.title,
            folderUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        }));
    }

    async renameSession(key: string, label: string): Promise<void> {
        const entry = this.knownSessions.get(key);
        if (entry) { entry.title = label; this.persistSessions(); }
    }

    async getSessionHistory(_limit?: number): Promise<HistoryMessage[]> {
        const id = this.activeSessionId;
        if (!id) return [];
        try {
            const res: any = await jsonRequest(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`, { headers: gooseHeaders(), timeoutMs: 6000 });
            const msgs: any[] = res?.messages || res?.conversation?.messages || res?.session?.messages || [];
            const out: HistoryMessage[] = [];
            for (const m of msgs) {
                const role = m.role === 'user' ? 'user' : 'assistant';
                const text = Array.isArray(m.content)
                    ? m.content.map((c: any) => (typeof c === 'string' ? c : (c.text || c.Text || ''))).join('')
                    : String(m.content || '');
                if (!text) continue;
                if (role === 'user') out.push({ role: 'user', content: text });
                else out.push({ role: 'assistant', content: [{ type: 'text', text }] });
            }
            return out;
        } catch { return []; }
    }

    async forkChat(parentSessionKey: string): Promise<string | null> {
        try {
            const res: any = await jsonRequest(`${this.baseUrl}/sessions/${encodeURIComponent(parentSessionKey)}/fork`, { method: 'POST', headers: gooseHeaders(), body: {} });
            const id = res?.id || res?.session_id;
            if (!id) return null;
            this.knownSessions.set(id, { title: 'Fork' });
            this.persistSessions();
            return id;
        } catch { return null; }
    }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        const sessionId = this.activeSessionId || await this.createChat();
        const runId = `goose-${Date.now()}`;

        this.mapperState = { reasoningParts: new Set(), textAccum: new Map() };
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: sessionId });

        try {
            await streamSse(
                `${this.baseUrl}/v1/sessions/${sessionId}/messages`,
                {
                    method: 'POST',
                    headers: gooseHeaders(),
                    body: { role: 'user', content: message },
                    timeoutMs: 300000,
                },
                (event) => {
                    const result = mapGooseSseEvent(runId, event.event, event.data, this.mapperState);
                    for (const ev of result.events) {
                        this.emit('stream', { ...ev, sessionKey: sessionId });
                    }
                    if (result.finished) {
                        this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey: sessionId });
                    }
                },
            );
        } catch (err: any) {
            Logger.getInstance().error('Goose sendChatMessage failed', err);
            this.emit('stream', { type: 'agent_message', runId, text: `Error: ${err.message || err}`, sessionKey: sessionId });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey: sessionId });
        }

        return { runId, sessionKey: sessionId };
    }

    async stopRun(_sessionKey?: string, _runId?: string): Promise<void> {}

    async getUsage(): Promise<any> { return null; }

    async injectMessage(_sessionKey: string, _message: string): Promise<boolean> { return false; }

    canSteer(): boolean { return false; }
    canAdminInject(): boolean { return false; }

    setSelection(selection: BridgeSelectionState): void { this.selection = selection; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        let providers: any[] = [];
        try {
            providers = await jsonRequest(`${this.baseUrl}/config/providers`, { headers: gooseHeaders(), timeoutMs: 4000 }) || [];
        } catch { return []; }
        const choices: ModelChoice[] = [];
        for (const p of providers) {
            if (p.is_configured === false) continue;
            const provName = p.name || p.metadata?.name;
            const models = p.metadata?.known_models || [];
            for (const m of models) {
                const id = `${provName}/${m.name}`;
                const reasoning = !!m.reasoning;
                const choice: ModelChoice = {
                    id, label: m.name, description: p.metadata?.display_name || provName,
                    provider: provName, model: m.name, supportsReasoning: reasoning,
                    icon: 'lightbulb', checked: selectedModel === id,
                };
                if (reasoning) {
                    choice.children = OPENCLAW_THINKING_LEVELS.map((level) => ({
                        id: `${id}:thinking:${level}`, label: level, icon: 'thinking', thinking: level,
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
        const modelId = provider ? `${provider}/${model}` : model;
        const thinking = data.thinking !== undefined ? String(data.thinking) : this.selection.thinking;
        this.setSelection({ ...this.selection, modelId, thinking });
        if (provider) {
            jsonRequest(`${this.baseUrl}/config/set_provider`, { method: 'POST', headers: gooseHeaders(), body: { provider, model } }).catch(() => {});
        }
        return { display: String(data.label ?? model), modelId, thinking };
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const connected = this.isConnected();
        return [{
            id: 'goose:status',
            label: connected ? `Connected (${this.baseUrl})` : 'Not connected',
            description: connected ? 'Goose server is running' : 'Start goose serve or set junction.goose.serverUrl',
            icon: connected ? 'check' : 'warning',
            bridgeId: 'goose',
        }, {
            id: 'goose:configure',
            label: 'Configure Goose',
            description: 'Bridge settings',
            icon: 'gear',
            bridgeId: 'goose',
        }];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        if (data.id === 'goose:configure') {
            vscode.commands.executeCommand('junction.openSettings');
        }
    }

    getEnvironmentLabel(): string {
        const home = gooseHome();
        const dirName = path.basename(home);
        if (dirName === 'goose') {
            // Try to find agent name from goose config
            const configFile = path.join(home, 'config.yaml');
            try {
                const content = fs.readFileSync(configFile, 'utf8');
                const nameMatch = content.match(/^name:\s*(\S+)/m) || content.match(/^#\s*(\S+)/m);
                if (nameMatch) return nameMatch[1];
            } catch {}
            return 'goose';
        }
        return dirName;
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const p = prefix.replace(/^\//, '').toLowerCase();
        return this.commandCache.filter((c) => !p || c.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null { return null; }
}

async function readGooseConfigPort(): Promise<number | null> {
    try {
        const configPath = path.join(gooseHome(), 'config.yaml');
        const text = await fs.promises.readFile(configPath, 'utf-8');
        // Match `port: <number>` or `server.port: <number>` variants
        const m = text.match(/\bport[\s:=]+(\d+)/);
        if (m) return parseInt(m[1], 10);
    } catch { /* absent or unreadable */ }
    return null;
}

async function gooseAutoDetect(timeoutMs = 200): Promise<string | null> {
    const configPort = await readGooseConfigPort();
    // Config-sniffer port first, then the well-known ACP default
    const ports = configPort
        ? [configPort, ...(configPort !== 3284 ? [3284] : [])]
        : [3284];
    for (const port of ports) {
        const url = `http://127.0.0.1:${port}`;
        try {
            await textRequest(url, { timeoutMs });
            return url;
        } catch { /* not here */ }
    }
    return null;
}
