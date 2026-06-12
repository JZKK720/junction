import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import { GatewayConnection } from '../../gateway/connection';
import { SessionManager } from '../../gateway/sessionManager';
import { CommandPalette } from '../../gateway/commandPalette';
import { ModelManager } from '../../gateway/modelManager';
import { ToolStatusManager } from '../../gateway/toolStatus';
import { abortRun, listAgents, setSessionModel } from '../../gateway/agentConfig';
import { discoverGateways } from '../../gateway/gatewayDiscovery';
import { getOwnedSessions } from '../../gateway/folderSessions';
import { registerGatewayTools } from '../../gateway/lmTools';
import { bindingIdForUri, ChatIndex } from '../../gateway/chatIndex';
import { MessageProcessor } from '../../utils/messageProcessor';
import { Logger } from '../../utils/logger';
import { getOpenClawConfigPath, getOpenClawGatewayUrl, updateOpenClawGateway } from '../../config/agentBridgeConfig';
import { BridgeCapabilities, BridgeContext, BridgeSelectionState, BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, ModelChoice, ToolStatusView } from '../types';

export class OpenClawBridge extends EventEmitter implements ChatBridge {
    readonly id = 'openclaw';
    readonly label = 'OpenClaw';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: true,
        steering: true,
        usage: true,
        tools: true,
    };

    private readonly gateway: GatewayConnection;
    private readonly sessionManager: SessionManager;
    private readonly commandPalette = new CommandPalette();
    private readonly modelManager = new ModelManager();
    private readonly toolStatusManager = new ToolStatusManager();
    private readonly chatIndex: ChatIndex;
    private selection: BridgeSelectionState = {};
    private integrationsRegistered = false;
    private runtimeLabels = new Map<string, string>();

    constructor(readonly context: vscode.ExtensionContext, instanceId: string) {
        super();
        this.gateway = new GatewayConnection(context.secrets, instanceId);
        this.sessionManager = new SessionManager(this.gateway, context);
        this.chatIndex = new ChatIndex(context, getOpenClawGatewayUrl);

        MessageProcessor.getInstance().registerEventHandlers(this.gateway);

        this.gateway.on('connected', () => this.emit('connected'));
        this.gateway.on('disconnected', () => this.emit('disconnected'));
        this.gateway.on('pairingRequired', () => this.emit('pairingRequired'));
        this.gateway.on('reconnected', () => this.emit('reconnected'));
        this.sessionManager.on('stream', (event) => this.emit('stream', event));
    }

    async connect(): Promise<boolean> {
        const ok = await this.gateway.connect();
        if (ok) {
            await this.refreshRuntimeLabels();
            await this.initializeWorkspace();
        }
        return ok;
    }

    disconnect(): void {
        this.gateway.disconnect();
    }

    isConnected(): boolean {
        return this.gateway.isConnected();
    }

    async initializeWorkspace(): Promise<void> {
        await this.sessionManager.initializeFolderSessions();
        await this.commandPalette.load(this.gateway).catch((e) => Logger.getInstance().error('commandPalette.load failed', e));
        await this.toolStatusManager.load(this.gateway).catch((e) => Logger.getInstance().error('toolStatusManager.load failed', e));
    }

    async registerRuntimeIntegrations(): Promise<void> {
        if (this.integrationsRegistered) return;
        this.integrationsRegistered = true;
        await registerGatewayTools(this.context, this.gateway, this.toolStatusManager);
    }

    async configure(): Promise<void> {
        const current = getOpenClawGatewayUrl();
        const targetUrl = await vscode.window.showInputBox({
            title: 'OpenClaw Runtime URL',
            prompt: 'WebSocket URL of the OpenClaw runtime',
            value: current,
            placeHolder: 'ws://127.0.0.1:18789',
            validateInput: v => (!v.startsWith('ws://') && !v.startsWith('wss://')) ? 'URL must start with ws:// or wss://' : undefined,
        });
        if (!targetUrl) return;
        const targetConfigPath = await vscode.window.showInputBox({
            title: 'OpenClaw config path',
            prompt: 'Optional openclaw.json path for this runtime',
            value: getOpenClawConfigPath(),
            placeHolder: '/home/e/entities/ling/openclaw.json',
        }) ?? '';
        if (targetUrl === current && targetConfigPath === getOpenClawConfigPath()) return;

        await updateOpenClawGateway(targetUrl, targetConfigPath);
        await Promise.resolve(this.context.secrets.delete('junction.openclaw.deviceToken')).catch(() => {});
        await Promise.resolve(this.context.secrets.delete('openclaw.deviceToken')).catch(() => {});
        this.modelManager.invalidate();
        this.gateway.disconnect();
        await this.connect();
        vscode.window.showInformationMessage(`OpenClaw connected to ${targetUrl}`);
    }

    getSettingsQuery(): string {
        return 'junction.';
    }

    setPendingFileContext(context: string): void {
        this.gateway.setPendingFileContext(context);
    }

    getPendingFileContext(): string | null {
        return this.gateway.getPendingFileContext();
    }

    getCurrentSessionKey(folderUri?: vscode.Uri): string | null {
        return this.sessionManager.getCurrentSessionKey(folderUri);
    }

    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> {
        return this.sessionManager.getSessionToFolder();
    }

    watchSession(key: string): void {
        this.gateway.watchSession(key);
    }

    unwatchSession(key: string): void {
        this.gateway.unwatchSession(key);
    }

    setActiveSession(folderUri: vscode.Uri, key: string): void {
        this.sessionManager.setActiveSession(folderUri, key);
    }

    createChat(folderUri?: vscode.Uri): Promise<string> {
        return this.sessionManager.createNewChat(folderUri);
    }

    async listSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
        if (!this.gateway.capabilities.canListSessions()) return [];
        const activeKey = this.getCurrentSessionKey() ?? undefined;
        const binding = this.sessionManager.getSessionToFolder();
        let raw: Array<{ key: string; label?: string }>;
        if (scope === 'all') {
            const res = await this.gateway.sendRequest('sessions.list', {});
            raw = Array.isArray(res?.sessions) ? res.sessions : [];
        } else {
            const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            raw = await getOwnedSessions(this.gateway);
            if (currentFolder) {
                raw = raw.filter((s) => binding.get(s.key)?.toString() === currentFolder.toString());
            }
        }
        if (scope === 'all') this.chatIndex.prune(new Set(raw.map((s) => s.key)));
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        return raw
            .filter((s) => includeArchived || !archivedKeys.has(s.key))
            .map((s) => {
                const folderUri = binding.get(s.key);
                const bindingId = folderUri ? bindingIdForUri(folderUri) : 'agent';
                const bindingLabel = folderUri ? folderUri.path.split('/').pop() || 'Chat' : 'Agent';
                const isCurrentGroup = !!folderUri && !!currentFolder
                    && folderUri.toString() === currentFolder.toString();
                const ts = (s as any).updatedAt ?? (s as any).lastActiveAt ?? (s as any).createdAt;
                this.chatIndex.upsert({
                    sessionKey: s.key,
                    bindingId,
                    bindingLabel,
                    summary: s.label || s.key,
                    model: scope === 'all' ? bindingLabel : undefined,
                });
                return {
                    key: s.key,
                    title: s.label || s.key.split(':').pop() || 'Untitled',
                    model: scope === 'all' ? bindingLabel : undefined,
                    isActive: s.key === activeKey,
                    isArchived: archivedKeys.has(s.key),
                    groupId: bindingId,
                    groupLabel: isCurrentGroup ? 'This folder' : bindingLabel,
                    isCurrentGroup,
                    lastActiveTs: typeof ts === 'number' ? ts : undefined,
                };
            });
    }

    async renameSession(key: string, label: string): Promise<void> {
        if (!this.gateway.capabilities.hasMethod('sessions.patch')) return;
        await this.gateway.sendRequest('sessions.patch', { key, label });
    }

    getSessionHistory(limit?: number, folderUri?: vscode.Uri): Promise<any> {
        return this.sessionManager.getSessionHistory(limit, folderUri);
    }

    getSessionHistoryFromJsonl(sessionKey: string, offset?: number, maxBytes?: number): Promise<any> {
        return this.sessionManager.getSessionHistoryFromJsonl(sessionKey, offset, maxBytes);
    }

    sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        return this.sessionManager.sendChatMessage(message, context);
    }

    stopRun(sessionKey: string, runId?: string): Promise<void> {
        return abortRun(this.gateway, sessionKey, runId);
    }

    getUsage(sessionKey: string): Promise<any> {
        return this.gateway.sendRequest('sessions.usage', { key: sessionKey });
    }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        try {
            if (this.gateway.capabilities.hasMethod('sessions.steer') || this.gateway.capabilities.canSteer()) {
                await this.gateway.sendRequest('sessions.steer', { key: sessionKey, message });
            } else {
                await this.gateway.sendRequest('chat.inject', { sessionKey, message });
            }
            return true;
        } catch (err) {
            if (this.gateway.capabilities.hasMethod('chat.inject') || this.gateway.capabilities.canSteer()) {
                try {
                    await this.gateway.sendRequest('chat.inject', { sessionKey, message });
                    return true;
                } catch (fallbackErr) {
                    Logger.getInstance().warn('OpenClaw steer/inject fallback failed', fallbackErr);
                }
            } else {
                Logger.getInstance().warn('OpenClaw steer/inject failed', err);
            }
            return false;
        }
    }

    canSteer(): boolean {
        return this.gateway.capabilities.canSteer();
    }

    canAdminInject(): boolean {
        return this.gateway.authScopes.includes('operator.admin');
    }

    setSelection(selection: BridgeSelectionState): void {
        this.selection = { ...this.selection, ...selection };
        this.sessionManager.setAgentOverrides({
            agentId: this.selection.agentId,
            provider: this.selection.modelId?.includes('/') ? this.selection.modelId.split('/')[0] : undefined,
            model: this.selection.modelId?.includes('/') ? this.selection.modelId.split('/').slice(1).join('/') : this.selection.modelId,
            thinking: this.selection.thinking,
        });
    }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        if (this.gateway.capabilities.canListModels()) {
            return this.modelManager.getModelChoices(this.gateway, selectedModel, selectedThinking, this.selection.agentId) as Promise<ModelChoice[]>;
        }
        return [];
    }

    async selectModelChoice(data: any, sessionKey?: string | null): Promise<{ display: string; modelId: string; thinking?: string; perRequestOnly?: boolean } | null> {
        const provider = String(data.provider ?? '');
        const model = String(data.model ?? data.id ?? '').replace(/^.*:/, '');
        if (!model) return null;
        const supportsReasoning = data.supportsReasoning !== false;
        const selectedThinking = data.thinking !== undefined ? String(data.thinking).trim() : '';
        const modelId = provider ? `${provider}/${model}` : model;
        const thinking = supportsReasoning ? (selectedThinking || this.selection.thinking) : undefined;
        this.setSelection({ modelId, thinking });

        let perRequestOnly = false;
        if (sessionKey) {
            const ok = await setSessionModel(this.gateway, sessionKey, provider, model, supportsReasoning ? thinking : null);
            perRequestOnly = !ok;
        }
        return {
            display: String(data.label ?? model) + (perRequestOnly ? ' (per-request)' : ''),
            modelId,
            thinking,
            perRequestOnly,
        };
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        await this.refreshRuntimeLabels();
        const currentUrl = getOpenClawGatewayUrl();
        const gateways = await discoverGateways().catch(() => []);
        const agents = this.gateway.capabilities.canListAgents()
            ? await listAgents(this.gateway).catch(() => [])
            : [];

        // Flat list: each agent × runtime combo is one item.
        const items: ChoiceMenuItem[] = [];
        for (const g of gateways) {
            const runtime = this.runtimeNameForUrl(g.url);
            const port = this.portForUrl(g.url);
            const runtimeAgents = g.url === currentUrl ? agents : [];
            if (runtimeAgents.length === 0) {
                // Runtime with no agent info — show as runtime:port
                items.push({
                    id: `openclaw:runtime:${g.url}`,
                    label: `${runtime}:${port}`,
                    description: g.url,
                    section: 'OpenClaw runtimes',
                    icon: 'server-environment',
                    checked: g.url === currentUrl,
                    url: g.url,
                    configPath: g.configPath,
                });
            } else {
                for (const agent of runtimeAgents) {
                    const agentId = agent.agentId || agent.id || '';
                    if (!agentId) continue;
                    items.push({
                        id: `openclaw:agent:${agentId}`,
                        label: `${agentId}@${runtime}:${port}`,
                        description: agent.displayName || agentId,
                        section: 'OpenClaw runtimes',
                        icon: 'hubot',
                        checked: agentId === this.selection.agentId && g.url === currentUrl,
                        agentId,
                        url: g.url,
                    });
                }
            }
        }
        if (!items.some((item) => item.url === currentUrl)) {
            const runtime = this.runtimeNameForUrl(currentUrl);
            const port = this.portForUrl(currentUrl);
            items.unshift({
                id: `openclaw:runtime:${currentUrl}`,
                label: `${runtime}:${port}`,
                description: currentUrl,
                section: 'OpenClaw runtimes',
                icon: 'server-environment',
                checked: true,
                url: currentUrl,
                configPath: getOpenClawConfigPath(),
            });
        }
        items.push({
            id: 'openclaw:configure',
            label: 'Configure OpenClaw runtime',
            description: currentUrl,
            section: 'OpenClaw runtimes',
            icon: 'gear',
        });

        return items;
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        const id = String(data.id ?? '');
        if (id === 'openclaw:configure') {
            await this.configure();
            return;
        }
        if (id.startsWith('openclaw:gateway:')) {
            const targetUrl = String(data.url ?? id.slice('openclaw:gateway:'.length));
            await updateOpenClawGateway(targetUrl, String(data.configPath ?? ''));
            await Promise.resolve(this.context.secrets.delete('junction.openclaw.deviceToken')).catch(() => {});
            await Promise.resolve(this.context.secrets.delete('openclaw.deviceToken')).catch(() => {});
            this.selection.agentId = undefined;
            this.modelManager.invalidate();
            this.gateway.disconnect();
            await this.connect();
            return;
        }
        if (id.startsWith('openclaw:agent:')) {
            this.setSelection({ agentId: String(data.agentId ?? id.slice('openclaw:agent:'.length)) });
        }
    }

    getEnvironmentLabel(): string {
        const url = getOpenClawGatewayUrl();
        const agent = this.selection.agentId || 'main';
        const runtime = this.runtimeNameForUrl(url);
        return `${agent}@${runtime}:${this.portForUrl(url)}`;
    }

    private async refreshRuntimeLabels(): Promise<void> {
        const gateways = await discoverGateways().catch(() => []);
        for (const gateway of gateways) {
            this.runtimeLabels.set(gateway.url, gateway.displayName);
        }
        const currentUrl = getOpenClawGatewayUrl();
        if (!this.runtimeLabels.has(currentUrl)) {
            this.runtimeLabels.set(currentUrl, this.runtimeNameFromConfigPath(getOpenClawConfigPath()) || this.hostForUrl(currentUrl));
        }
    }

    private runtimeNameForUrl(url: string): string {
        return this.runtimeLabels.get(url)
            || this.runtimeNameFromConfigPath(getOpenClawConfigPath())
            || this.hostForUrl(url)
            || 'openclaw';
    }

    private runtimeNameFromConfigPath(configPath: string): string {
        if (!configPath) return '';
        const dirName = path.basename(path.dirname(configPath));
        return dirName.startsWith('.') ? dirName.slice(1) : dirName;
    }

    private hostForUrl(url: string): string {
        try { return new URL(url.replace(/^ws/, 'http')).hostname || 'openclaw'; } catch { return 'openclaw'; }
    }

    private portForUrl(url: string): string {
        try { return new URL(url.replace(/^ws/, 'http')).port || ''; } catch { return ''; }
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        return this.commandPalette.getSuggestions(prefix);
    }

    getToolStatus(): ToolStatusView | null {
        return this.toolStatusManager.getStatus();
    }
}
