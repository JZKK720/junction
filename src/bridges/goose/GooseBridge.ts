import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { jsonRequest, streamSse, textRequest } from '../http';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChoiceMenuItem,
    ModelChoice, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { mapGooseSseEvent, GooseMapperState } from './events';

function gooseConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.goose');
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
        models: false,
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

        this.emit('connected');
        return true;
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
    getPendingFileContext(): string | null { return this.pendingFileContext; }

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
            const res: any = await jsonRequest(`${this.baseUrl}/v1/sessions`, { method: 'POST', body: {} });
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

    async getSessionHistory(limit?: number): Promise<any[]> { return []; }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        const sessionId = this.activeSessionId || await this.createChat();
        const runId = `goose-${Date.now()}`;

        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey: sessionId });

        const ctxStr = context?.workspace ? `[Workspace: ${context.workspace}]` : '';
        const fullText = [ctxStr, message].filter(Boolean).join('\n\n');

        try {
            await streamSse(
                `${this.baseUrl}/v1/sessions/${sessionId}/messages`,
                {
                    method: 'POST',
                    body: { role: 'user', content: fullText },
                    timeoutMs: 300000,
                },
                (event) => {
                    this.mapperState = { reasoningParts: new Set(), textAccum: new Map() };
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

    async listModelChoices(): Promise<ModelChoice[]> { return []; }
    async selectModelChoice(): Promise<any> {}

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

    getSlashSuggestions(_prefix: string): Array<{ name: string; description?: string }> { return []; }

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
