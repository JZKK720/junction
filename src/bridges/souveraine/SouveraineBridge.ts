import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getSouveraineBaseUrl, getSouveraineHome, souveraineConfig, updateSouveraineRuntime } from '../../config/agentBridgeConfig';
import { jsonRequest, streamSse } from '../http';
import { BridgeCapabilities, BridgeContext, BridgeSelectionState, BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, ModelChoice, OPENCLAW_THINKING_LEVELS, ToolStatusView } from '../types';
import { Logger } from '../../utils/logger';
import { mapSouveraineSseEvent } from './events';

export class SouveraineBridge extends EventEmitter implements ChatBridge {
    readonly id = 'souveraine';
    readonly label = 'Souveraine';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: true,
        steering: true,
        usage: false,
        tools: true,
    };

    private activeConversationId: string | null = null;
    private agentId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = { modelId: 'openai/kimi-k2.6' };
    private knownConversations = new Map<string, { title: string; model?: string }>();
    private buffers = new Map<string, string>();
    private activeAbortController: AbortController | null = null;

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string }]>>('junction.souveraine.knownConversations');
        if (saved) {
            this.knownConversations = new Map(saved);
        }
        this.activeConversationId = this.context.workspaceState.get<string | null>('junction.souveraine.activeConversationId', null);
    }

    private persistSessions(): void {
        const data = Array.from(this.knownConversations.entries());
        this.context.workspaceState.update('junction.souveraine.knownConversations', data);
        this.context.workspaceState.update('junction.souveraine.activeConversationId', this.activeConversationId);
    }

    async connect(): Promise<boolean> {
        try {
            await this.ensureManagedRuntime();
            await this.ensureAgent();
            this.emit('connected');
            return true;
        } catch (err) {
            Logger.getInstance().warn('Souveraine bridge connect failed', err);
            this.emit('disconnected');
            return false;
        }
    }

    disconnect(): void {
        this.emit('disconnected');
    }

    isConnected(): boolean {
        return true;
    }

    async initializeWorkspace(): Promise<void> {
        await this.ensureManagedRuntime();
    }

    async registerRuntimeIntegrations(): Promise<void> {
        await this.ensureManagedRuntime();
    }

    async configure(): Promise<void> {
        const baseUrl = await vscode.window.showInputBox({
            title: 'Souveraine base URL',
            value: getSouveraineBaseUrl(),
            placeHolder: 'http://127.0.0.1:8484',
        });
        if (!baseUrl) return;
        const home = await vscode.window.showInputBox({
            title: 'Souveraine home',
            value: getSouveraineHome(),
            placeHolder: '~/.souveraine-souvieling-home',
        });
        if (!home) return;
        await updateSouveraineRuntime({ baseUrl, home });
        this.agentId = null;
        await this.connect();
    }

    getSettingsQuery(): string {
        return 'junction.souveraine';
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
        return this.activeConversationId;
    }

    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> {
        return new Map();
    }

    setActiveSession(_folderUri: vscode.Uri, key: string): void {
        this.activeConversationId = key;
        this.context.workspaceState.update('junction.souveraine.activeConversationId', key);
    }

    async createChat(): Promise<string> {
        await this.ensureAgent();
        const res = await jsonRequest<any>(`${getSouveraineBaseUrl()}/v1/conversations`, {
            method: 'POST',
            body: { agent_id: this.agentId },
        });
        const id = String(res?.id || res?.conversation?.id || '');
        if (!id) throw new Error('Souveraine did not return conversation id');
        this.activeConversationId = id;
        this.knownConversations.set(id, {
            title: `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
            model: this.selection.modelId,
        });
        this.persistSessions();
        return id;
    }

    async listSessions(_scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
        await this.ensureAgent().catch(() => undefined);
        const local = [...this.knownConversations.entries()]
            .filter(([key]) => includeArchived || !archivedKeys.has(key))
            .map(([key, value]) => ({
                key,
                title: value.title,
                model: value.model,
                isActive: key === this.activeConversationId,
                isArchived: archivedKeys.has(key),
                groupId: 'recent',
                groupLabel: 'Recent',
                isCurrentGroup: true,
            }));
        return local;
    }

    async renameSession(key: string, label: string): Promise<void> {
        const existing = this.knownConversations.get(key) ?? { title: label, model: this.selection.modelId };
        existing.title = label;
        this.knownConversations.set(key, existing);
        this.persistSessions();
    }

    async getSessionHistory(): Promise<any> {
        if (!this.activeConversationId) return { messages: [] };
        try {
            const res = await jsonRequest<any>(`${getSouveraineBaseUrl()}/v1/conversations/${this.activeConversationId}/messages`, {
                method: 'GET',
            });
            const rawMessages = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : []);
            const messages: any[] = [];
            for (const msg of rawMessages) {
                if (!msg) continue;
                let role = msg.role;
                if (!role && msg.message_type) {
                    if (msg.message_type === 'user_message') role = 'user';
                    else if (msg.message_type === 'assistant_message') role = 'assistant';
                    else if (msg.message_type === 'reasoning_message') role = 'assistant';
                }
                if (role !== 'user' && role !== 'assistant') {
                    continue;
                }
                
                let content = '';
                if (typeof msg.content === 'string') {
                    content = msg.content;
                } else if (Array.isArray(msg.content)) {
                    const parts: string[] = [];
                    for (const part of msg.content) {
                        if (typeof part === 'string') parts.push(part);
                        else if (part && typeof part === 'object') {
                            if (part.text) parts.push(part.text);
                            else if (part.content) parts.push(part.content);
                        }
                    }
                    content = parts.join('');
                } else if (msg.text) {
                    content = msg.text;
                }
                
                messages.push({
                    role,
                    content,
                });
            }
            return { messages };
        } catch (err) {
            Logger.getInstance().warn('Failed to fetch Souveraine session history', err);
            return { messages: [] };
        }
    }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        await this.ensureAgent();
        if (!this.activeConversationId) await this.createChat();
        const runId = this.activeConversationId!;
        const text = context?.workspace ? `[Workspace: ${context.workspace}]\n${message}` : message;
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId });
        
        if (this.activeAbortController) {
            this.activeAbortController.abort();
        }
        this.activeAbortController = new AbortController();
        const signal = this.activeAbortController.signal;

        try {
            await streamSse(`${getSouveraineBaseUrl()}/v1/conversations/${encodeURIComponent(runId)}/messages`, {
                method: 'POST',
                body: {
                    stream: true,
                    messages: [{ role: 'user', content: text }],
                },
                signal,
            }, (event) => this.mapSse(runId, event.event, event.data));
        } finally {
            if (this.activeAbortController?.signal === signal) {
                this.activeAbortController = null;
            }
        }
        
        this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId });
        return { conversation_id: runId };
    }

    async stopRun(): Promise<void> {
        // SSE request cancellation: abort stream if active
        // Comment: Souveraine has no server-side run-cancel endpoint; the server may finish the turn internally.
        // We just stop listening by aborting the SSE request client-side.
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
        }
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: this.activeConversationId || 'souveraine' });
    }

    async getUsage(): Promise<any> {
        return {};
    }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        // E's ruling contract: POST /v1/conversations/{id}/interject with { "text": message }
        // Future server implementation will process this endpoint to steer the running conversation turn.
        try {
            await jsonRequest<any>(`${getSouveraineBaseUrl()}/v1/conversations/${sessionKey}/interject`, {
                method: 'POST',
                body: { text: message },
            });
            return true;
        } catch (err) {
            Logger.getInstance().warn('Souveraine steer/interject endpoint failed (expected until server updates)', err);
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
        const models = ['openai/kimi-k2.6', 'openai/deepseek-v4-pro'];
        // Souveraine exposes no per-model reasoning-effort catalog; its models reason
        // via the OpenClaw level system, so offer the canonical levels (forced
        // per-request). Swap in real per-model efforts if the API gains a caps endpoint.
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
                checked: selectedModel === id || selectedModel === model,
                children: OPENCLAW_THINKING_LEVELS.map((level) => ({
                    id: `${id}:thinking:${level}`,
                    label: level,
                    icon: 'thinking',
                    thinking: level,
                    checked: (selectedModel === id || selectedModel === model) && selectedThinking === level,
                })),
            };
        });
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const provider = String(data.provider ?? '');
        const model = String(data.model ?? data.id ?? '').replace(/^.*:/, '');
        if (!model) return null;
        const modelId = provider ? `${provider}/${model}` : model;
        const thinking = data.thinking !== undefined ? String(data.thinking) : this.selection.thinking;
        this.setSelection({ modelId, thinking });
        if (this.activeConversationId) {
            const known = this.knownConversations.get(this.activeConversationId) ?? { title: this.activeConversationId };
            known.model = modelId;
            this.knownConversations.set(this.activeConversationId, known);
            this.persistSessions();
        }
        return { display: String(data.label ?? model), modelId, thinking };
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const available = await jsonRequest<any>(`${getSouveraineBaseUrl()}/v1/agents`, { timeoutMs: 250 }).then((r) => Array.isArray(r)).catch(() => false);
        const port = portFromUrl(getSouveraineBaseUrl());
        if (!available) {
            return [
                {
                    id: 'souveraine:autodetect',
                    label: 'Auto-detect Souveraine',
                    description: 'Scan common ports for a running Souveraine instance',
                    section: 'Souveraine',
                    icon: 'search',
                    setup: true,
                },
                {
                    id: 'souveraine:settings',
                    label: 'Configure Souveraine',
                    description: 'Bridge settings',
                    section: 'Souveraine',
                    icon: 'gear',
                    setup: true,
                },
            ];
        }
        return [
            {
                id: 'souveraine:managed',
                label: `souvieling@souveraine:${port}`,
                description: 'Detected Souveraine runtime',
                section: 'Souveraine',
                icon: 'hubot',
                checked: true,
            },
            {
                id: 'souveraine:settings',
                label: 'Configure Souveraine',
                description: 'Bridge settings',
                section: 'Souveraine',
                icon: 'gear',
            },
        ];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        const id = String(data.id ?? '');
        if (id === 'souveraine:settings') { await this.configure(); return; }
        if (id === 'souveraine:autodetect') {
            const found = await souverainAutoDetect();
            if (found) {
                await updateSouveraineRuntime({ baseUrl: found });
                await this.connect();
            } else {
                vscode.window.showInformationMessage('Souveraine: no running instance found on common ports.');
            }
        }
    }

    getEnvironmentLabel(): string {
        return `souvieling@souveraine:${portFromUrl(getSouveraineBaseUrl())}`;
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        return [{ name: 'status', description: 'Show Souveraine bridge status' }].filter((item) => item.name.startsWith(prefix));
    }

    getToolStatus(): ToolStatusView | null {
        return null;
    }

    private mapSse(runId: string, eventName: string, data: string): void {
        const mapped = mapSouveraineSseEvent(runId, eventName, data, this.buffers.get(runId) || '');
        if (mapped.nextText !== undefined) this.buffers.set(runId, mapped.nextText);
        for (const event of mapped.events) this.emit('stream', event);
    }

    private async ensureManagedRuntime(): Promise<void> {
        await this.writeConfigAndIdentity();
        try {
            await jsonRequest(`${getSouveraineBaseUrl()}/health`, { timeoutMs: 1000 });
            return;
        } catch {}
        this.spawnServer();
        for (let i = 0; i < 45; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                await jsonRequest(`${getSouveraineBaseUrl()}/health`, { timeoutMs: 1000 });
                return;
            } catch {}
        }
    }

    private async ensureAgent(): Promise<void> {
        if (this.agentId) return;
        await this.ensureManagedRuntime();
        const agents = await jsonRequest<any[]>(`${getSouveraineBaseUrl()}/v1/agents`).catch(() => []);
        const found = Array.isArray(agents) ? agents.find((a) => a?.name === 'souvieling') : undefined;
        if (found?.id) {
            this.agentId = String(found.id);
            return;
        }
        const identity = await this.readIdentity();
        const created = await jsonRequest<any>(`${getSouveraineBaseUrl()}/v1/agents`, {
            method: 'POST',
            body: {
                name: 'souvieling',
                description: 'Ling incarnation on the Souveraine harness.',
                llm_config: {
                    model: this.selection.modelId || 'openai/kimi-k2.6',
                    context_window: 128000,
                    max_tool_rounds: 10,
                    inter_round_delay_ms: 500,
                    supports_images: true,
                    checkpoint_interval: 10,
                },
                memory_blocks: [
                    { label: 'agents', value: identity.agents },
                    { label: 'soul', value: identity.soul },
                ],
                tools: [],
                tags: ['junction', 'ling', 'incarnation', 'souvieling'],
            },
            timeoutMs: 30000,
        });
        this.agentId = String(created?.id || created?.agent?.id || '');
        if (!this.agentId) throw new Error('Souveraine did not return agent id');
    }

    private async readIdentity(): Promise<{ agents: string; soul: string }> {
        const home = process.env.HOME || '~';
        const read = async (file: string) => fs.promises.readFile(file, 'utf8').catch(() => '');
        const base = path.join(home, 'entities', 'ling', 'workspace-灵');
        return {
            agents: await read(path.join(base, 'AGENTS.md')),
            soul: (await read(path.join(base, 'SOUL_INCARNATION.md'))).replace(/\{harness\}/g, 'Souveraine'),
        };
    }

    private async writeConfigAndIdentity(): Promise<void> {
        const home = getSouveraineHome();
        const state = path.join(home, '.souveraine');
        await fs.promises.mkdir(state, { recursive: true });
        const configPath = path.join(state, 'config.toml');
        // Regenerate bridge-managed config if missing or stale (pre-oauth versions
        // pointed at a bifrost gateway that may not exist on this machine).
        const existing = fs.existsSync(configPath)
            ? await fs.promises.readFile(configPath, 'utf8').catch(() => '')
            : '';
        if (!existing.includes('provider = "openai-oauth"')) {
            const config = [
                '[server]',
                'bind = "127.0.0.1"',
                'port = 8484',
                'url = "http://127.0.0.1:8484"',
                '',
                '[server.auth]',
                'required = true',
                'allow_loopback = true',
                '',
                '[bifrost]',
                '# Ride the Codex CLI ChatGPT login (~/.codex/auth.json via CODEX_HOME).',
                'provider = "openai-oauth"',
                'base_url = "http://127.0.0.1:3360"',
                'primary_model = "gpt-5.5"',
                '',
            ].join('\n');
            await fs.promises.writeFile(configPath, config, 'utf8');
        }
    }

    private spawnServer(): void {
        const repo = souveraineConfig().get<string>('repoPath', '');
        if (!repo || !fs.existsSync(repo)) return;
        const home = getSouveraineHome();
        const realHome = process.env.HOME || home;
        const logDir = path.join(home, '.souveraine', 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const out = fs.openSync(path.join(logDir, 'server.log'), 'a');
        const child = spawn(process.env.CARGO || 'cargo', [
            'run',
            '--release',
            '--manifest-path',
            path.join(repo, 'Cargo.toml'),
            '--',
            'server',
            '--bind',
            '127.0.0.1',
            '--port',
            '8484',
        ], {
            cwd: home,
            detached: true,
            stdio: ['ignore', out, out],
            env: {
                ...process.env,
                HOME: home,
                // HOME is overridden for state isolation, so point the
                // openai-oauth provider back at the real Codex CLI login.
                CODEX_HOME: process.env.CODEX_HOME || path.join(realHome, '.codex'),
                CARGO_HOME: process.env.CARGO_HOME || path.join(realHome, '.cargo'),
                RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(realHome, '.rustup'),
            },
        });
        child.unref();
    }
}

function portFromUrl(value: string): string {
    try { return new URL(value).port || ''; } catch { return ''; }
}

async function souverainAutoDetect(timeoutMs = 200): Promise<string | null> {
    const ports = [8484, 8080, 8000, 9000];
    const results = await Promise.all(ports.map(async (port) => {
        const url = `http://127.0.0.1:${port}`;
        try {
            const agents = await jsonRequest<any>(`${url}/v1/agents`, { timeoutMs });
            return Array.isArray(agents) ? url : null;
        } catch {
            return null;
        }
    }));
    return results.find((r) => r !== null) ?? null;
}
