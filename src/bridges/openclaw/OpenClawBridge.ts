import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { GatewayConnection } from '../../gateway/connection';
import { SessionManager } from '../../gateway/sessionManager';
import { CommandPalette } from '../../gateway/commandPalette';
import { ModelManager } from '../../gateway/modelManager';
import { ToolStatusManager } from '../../gateway/toolStatus';
import { abortRun, listAgents } from '../../gateway/agentConfig';
import { discoverGateways } from '../../gateway/gatewayDiscovery';
import { registerGatewayTools } from '../../gateway/lmTools';
import { ChatIndex } from '../../gateway/chatIndex';
import { MessageProcessor } from '../../utils/messageProcessor';
import { ApprovalRelay } from '../../gateway/approvalRelay';
import { Logger } from '../../utils/logger';
import { getOpenClawConfigPath, getOpenClawGatewayUrl, getOpenClawShowAllAgents, updateOpenClawGateway } from '../../config/agentBridgeConfig';
import { BridgeCapabilities, BridgeContext, BridgeMessageReactionTarget, BridgeSelectionState, BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, ModelChoice, ToolStatusView } from '../types';
import { listOpenClawModelChoices, selectOpenClawModelChoice } from './modelPicker';
import { listOpenClawWorkspaceSessions } from './workspaceSessions';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';

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
        messageReactions: true,
        timelineInterleaves: true,
        hidesRawThinking: true,
    };

    private readonly gateway: GatewayConnection;
    private readonly sessionManager: SessionManager;
    private readonly commandPalette = new CommandPalette();
    private readonly modelManager = new ModelManager();
    private readonly toolStatusManager = new ToolStatusManager();
    private readonly approvalRelay: ApprovalRelay;
    private readonly chatIndex: ChatIndex;
    private selection: BridgeSelectionState = {};
    private integrationsRegistered = false;
    private runtimeLabels = new Map<string, string>();
    private deliveryContextBySession = new Map<string, any>();

    constructor(readonly context: vscode.ExtensionContext, instanceId: string) {
        super();
        this.gateway = new GatewayConnection(context.secrets, instanceId);
        this.sessionManager = new SessionManager(this.gateway, context);
        this.chatIndex = new ChatIndex(context, getOpenClawGatewayUrl);

        MessageProcessor.getInstance().registerEventHandlers(this.gateway);
        this.approvalRelay = new ApprovalRelay(this.gateway, (event) => {
            captureBridgeDebug(this.id, 'normalized', { operation: 'approvalRelay', eventType: event?.type, sessionKey: event?.sessionKey, runId: event?.runId, event });
            this.emit('stream', event);
        });

        this.gateway.on('connected', () => this.emit('connected'));
        this.gateway.on('disconnected', () => this.emit('disconnected'));
        this.gateway.on('pairingRequired', () => this.emit('pairingRequired'));
        this.gateway.on('reconnected', () => {
            this.emit('reconnected');
            void this.approvalRelay.recoverPending();
        });
        this.sessionManager.on('stream', (event) => {
            captureBridgeDebug(this.id, 'normalized', { operation: 'sessionManager.stream', eventType: event?.type, sessionKey: event?.sessionKey, runId: event?.runId, event });
            this.emit('stream', event);
        });
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
        await this.commandPalette.load(this.gateway, this.selection.agentId || 'main').catch((e) => Logger.getInstance().error('commandPalette.load failed', e));
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
            placeHolder: '~/.openclaw/openclaw.json',
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

    async forkChat(parentSessionKey: string, folderUri?: vscode.Uri): Promise<string | null> {
        if (!parentSessionKey || !this.gateway.capabilities.hasMethod('sessions.fork')) return null;
        const workspaceDir = folderUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const res = await this.gateway.sendRequest('sessions.fork', {
            parentSessionKey,
            ...(workspaceDir ? { workspaceDir } : {}),
        });
        const key = typeof res?.key === 'string' ? res.key : null;
        if (key && folderUri) this.sessionManager.setActiveSession(folderUri, key);
        return key;
    }

    async listSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
        const sessions = await listOpenClawWorkspaceSessions({
            gateway: this.gateway,
            sessionManager: this.sessionManager,
            chatIndex: this.chatIndex,
            scope,
            includeArchived,
            archivedKeys,
            onRawSessions: (raw) => this.cacheDeliveryContexts(raw),
        });
        return sessions;
    }

    listWorkspaceSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]> {
        return this.listSessions(scope, includeArchived, archivedKeys);
    }

    async renameSession(key: string, label: string): Promise<void> {
        if (!this.gateway.capabilities.hasMethod('sessions.patch')) return;
        await this.gateway.sendRequest('sessions.patch', { key, label });
    }

    async getSessionHistory(limit?: number, folderUri?: vscode.Uri): Promise<any> {
        captureBridgeHistoryDebug(this.id, 'history-native', { operation: 'getSessionHistory.request', sessionKey: this.getCurrentSessionKey(folderUri), limit, folderUri: folderUri?.fsPath });
        const history = await this.sessionManager.getSessionHistory(limit, folderUri);
        captureBridgeHistoryDebug(this.id, 'history-normalized', { operation: 'getSessionHistory.result', sessionKey: this.getCurrentSessionKey(folderUri), history });
        return history;
    }

    getSessionHistoryFromJsonl(sessionKey: string, offset?: number, maxBytes?: number): Promise<any> {
        return this.sessionManager.getSessionHistoryFromJsonl(sessionKey, offset, maxBytes);
    }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        const sessionKey = this.getCurrentSessionKey(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined);
        captureBridgeDebug(this.id, 'request', { operation: 'sendChatMessage', sessionKey, message, context });
        await this.recoverStaleTerminalRun(sessionKey, 'send-preflight');
        try {
            return await this.sessionManager.sendChatMessage(message, context);
        } catch (error) {
            const recovered = await this.recoverStaleTerminalRun(
                this.getCurrentSessionKey(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined) ?? sessionKey,
                'send-retry',
            );
            if (recovered) return await this.sessionManager.sendChatMessage(message, context);
            throw error;
        }
    }

    async setMessageReaction(target: BridgeMessageReactionTarget, value: 'up' | 'down' | null): Promise<void> {
        if (!this.gateway.capabilities.hasMethod('message.action')) {
            throw new Error('OpenClaw gateway does not expose native message.action reactions.');
        }
        const sessionKey = String(target.sessionKey || this.getCurrentSessionKey() || '').trim();
        const delivery = await this.resolveDeliveryContext(sessionKey);
        const channel = String(target.channel || delivery?.channel || '').trim();
        const to = String(target.to || delivery?.to || delivery?.target || '').trim();
        const accountId = String(target.accountId || delivery?.accountId || '').trim();
        const nativeMessageId = String(target.nativeMessageId || '').trim();
        const localMessageId = String(target.messageId || '').trim();
        const messageId = nativeMessageId || (/^(?:a|m)-/.test(localMessageId) ? '' : localMessageId);
        if (!channel || !to || !messageId) {
            throw new Error('OpenClaw native reaction target missing channel, recipient, or gateway message id.');
        }

        const previous = target.previousReaction === 'up' || target.previousReaction === 'down'
            ? target.previousReaction
            : null;
        const reactions: Array<'up' | 'down'> = value === null
            ? (previous ? [previous] : ['up', 'down'])
            : [value];
        for (const reaction of reactions) {
            await this.gateway.sendRequest('message.action', {
                channel,
                action: 'react',
                params: {
                    to,
                    messageId,
                    emoji: this.nativeReactionFor(channel, reaction),
                    remove: value === null,
                },
                ...(accountId ? { accountId } : {}),
                ...(sessionKey ? { sessionKey } : {}),
                idempotencyKey: `junction:${sessionKey || channel}:${messageId}:${reaction}:${value === null ? 'remove' : 'set'}:${Date.now()}`,
            });
        }
    }

    async executeSlashCommand(command: string, context?: BridgeContext): Promise<any> {
        const sessionKey = this.getCurrentSessionKey(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined);
        await this.recoverStaleTerminalRun(sessionKey, 'slash-preflight');
        try {
            return await this.sessionManager.sendChatMessage(command, context);
        } catch (error) {
            const recovered = await this.recoverStaleTerminalRun(
                this.getCurrentSessionKey(context?.workspaceFolder ? vscode.Uri.file(context.workspaceFolder) : undefined) ?? sessionKey,
                'slash-retry',
            );
            if (recovered) return await this.sessionManager.sendChatMessage(command, context);
            throw error;
        }
    }

    async stopRun(sessionKey: string, runId?: string): Promise<void> {
        await abortRun(this.gateway, sessionKey, runId);
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: runId || `openclaw-stop-${Date.now()}`, sessionKey });
    }

    private async recoverStaleTerminalRun(sessionKey: string | null | undefined, operation: string): Promise<boolean> {
        if (!sessionKey || (this.gateway.capabilities.methodsKnown && !this.gateway.capabilities.hasMethod('sessions.describe'))) return false;
        try {
            const described = await this.gateway.sendRequest('sessions.describe', { key: sessionKey }, { timeoutMs: 1500 });
            const session = described?.session;
            const status = String(session?.status ?? '').toLowerCase();
            const hasActiveRun = session?.hasActiveRun === true;
            if (!hasActiveRun || !this.isTerminalSessionStatus(status)) return false;
            captureBridgeDebug(this.id, 'request', { operation: 'recoverStaleTerminalRun', phase: operation, sessionKey, status, hasActiveRun });
            await abortRun(this.gateway, sessionKey);
            return true;
        } catch (error) {
            Logger.getInstance().warn('OpenClaw stale run recovery failed', error);
            captureBridgeDebug(this.id, 'normalized', { operation: 'recoverStaleTerminalRun.failed', phase: operation, sessionKey, error: String(error) });
            return false;
        }
    }

    private isTerminalSessionStatus(status: string): boolean {
        return status === 'killed'
            || status === 'done'
            || status === 'failed'
            || status === 'error'
            || status === 'cancelled'
            || status === 'canceled'
            || status === 'completed';
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

    /** Resolve an inline approval card → exec/plugin approval.resolve (the relay
     *  maps the neutral choice to OpenClaw's decision vocabulary + routes kind). */
    async respondApproval(data: { requestId?: string; choice: string }): Promise<void> {
        if (!data.requestId) return;
        await this.approvalRelay.respond(data.requestId, data.choice);
    }

    /** Manually compact a session's context (sessions.compact). */
    async compactContext(sessionKey: string): Promise<void> {
        const key = sessionKey || this.getCurrentSessionKey() || '';
        if (!key) return;
        await this.gateway.sendRequest('sessions.compact', { key });
    }

    /** Context-window usage for the meter: session totals ÷ the active model's window. */
    async getContextUsage(sessionKey: string): Promise<{ percentUsed?: number; usedTokens?: number; contextWindow?: number } | null> {
        const key = sessionKey || this.getCurrentSessionKey() || '';
        if (!key) return null;
        try {
            const u: any = await this.gateway.sendRequest('sessions.usage', { key });
            const usedTokens = Number(u?.contextTokens ?? ((u?.inputTokens || 0) + (u?.outputTokens || 0))) || 0;
            const contextWindow = this.modelManager.getModelById(this.selection.modelId ?? '')?.contextWindow;
            const percentUsed = contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : undefined;
            return { percentUsed, usedTokens, contextWindow };
        } catch (err) {
            Logger.getInstance().warn('OpenClaw getContextUsage failed', err);
            return null;
        }
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

    getSelection(): BridgeSelectionState {
        return { ...this.selection };
    }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        return listOpenClawModelChoices(this.gateway, this.modelManager, selectedModel, selectedThinking, this.selection.agentId);
    }

    async selectModelChoice(data: any, sessionKey?: string | null): Promise<{ display: string; modelId: string; thinking?: string; perRequestOnly?: boolean } | null> {
        const selected = await selectOpenClawModelChoice(this.gateway, data, this.selection, sessionKey);
        if (!selected) return null;
        this.setSelection({ modelId: selected.modelId, thinking: selected.thinking });
        return selected;
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        await this.refreshRuntimeLabels();
        const currentUrl = getOpenClawGatewayUrl();
        const gateways = await discoverGateways().catch(() => []);
        const connected = this.gateway.isConnected();

        if (gateways.length === 0 && !connected) {
            return [
                {
                    id: 'openclaw:autodetect',
                    label: 'Auto-detect runtimes',
                    description: 'Scan for running OpenClaw gateways',
                    section: 'OpenClaw',
                    icon: 'search',
                    setup: true,
                },
                {
                    id: 'openclaw:select-config',
                    label: 'Set config path manually…',
                    description: 'Browse for an openclaw.json',
                    section: 'OpenClaw',
                    icon: 'file',
                    setup: true,
                },
                {
                    id: 'openclaw:configure',
                    label: 'Configure OpenClaw',
                    description: currentUrl,
                    section: 'OpenClaw',
                    icon: 'gear',
                    setup: true,
                },
            ];
        }

        const agents = this.gateway.capabilities.canListAgents()
            ? await listAgents(this.gateway).catch(() => [])
            : [];

        // Flat list: each agent × runtime combo is one item.
        const items: ChoiceMenuItem[] = [];
        const anyConnected = this.gateway.isConnected();
        const showAllAgents = getOpenClawShowAllAgents();
        for (const g of gateways) {
            const runtime = this.runtimeNameForUrl(g.url);
            const port = this.portForUrl(g.url);
            let runtimeAgents = g.url === currentUrl ? agents : [];
            // Default to the gateway's primary agent only (first in config
            // agents.list); hide child/extra agents unless showAllAgents is set.
            // Fall back to the full list if the primary id can't be matched.
            if (!showAllAgents && g.primaryAgentId && runtimeAgents.length > 1) {
                const primaryOnly = runtimeAgents.filter(
                    (a) => (a.agentId || a.id) === g.primaryAgentId,
                );
                if (primaryOnly.length) runtimeAgents = primaryOnly;
            }
            const isConnected = anyConnected;
            if (runtimeAgents.length === 0) {
                // Runtime with no agent info — show as runtime:port
                items.push({
                    id: `openclaw:runtime:${g.url}`,
                    label: `${runtime}:${port}`,
                    description: g.url,
                    section: 'OpenClaw runtimes',
                    icon: isConnected ? 'server-environment' : 'debug-disconnect',
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
                        icon: isConnected ? 'hubot' : 'debug-disconnect',
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
            const isConnected = this.gateway.isConnected();
            items.unshift({
                id: `openclaw:runtime:${currentUrl}`,
                label: `${runtime}:${port}`,
                description: currentUrl,
                section: 'OpenClaw runtimes',
                icon: isConnected ? 'server-environment' : 'debug-disconnect',
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
        if (id === 'openclaw:autodetect') {
            const gateways = await discoverGateways().catch(() => []);
            if (gateways.length > 0) {
                const g = gateways[0];
                await updateOpenClawGateway(g.url, g.configPath ?? '');
                await Promise.resolve(this.context.secrets.delete('junction.openclaw.deviceToken')).catch(() => {});
                await Promise.resolve(this.context.secrets.delete('openclaw.deviceToken')).catch(() => {});
                this.selection.agentId = undefined;
                this.modelManager.invalidate();
                this.gateway.disconnect();
                await this.connect();
            } else {
                vscode.window.showInformationMessage('OpenClaw: no running gateways found.');
            }
            return;
        }
        if (id === 'openclaw:select-config') {
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'OpenClaw config': ['json'] },
                title: 'Select openclaw.json',
            });
            if (result?.[0]) {
                const configPath = result[0].fsPath;
                try {
                    const raw = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
                    const port = raw?.gateway?.port;
                    const url = port ? `ws://127.0.0.1:${port}` : getOpenClawGatewayUrl();
                    await updateOpenClawGateway(url, configPath);
                } catch {
                    await updateOpenClawGateway(getOpenClawGatewayUrl(), configPath);
                }
                await Promise.resolve(this.context.secrets.delete('junction.openclaw.deviceToken')).catch(() => {});
                await Promise.resolve(this.context.secrets.delete('openclaw.deviceToken')).catch(() => {});
                this.selection.agentId = undefined;
                this.modelManager.invalidate();
                this.gateway.disconnect();
                await this.connect();
            }
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
        return this.runtimeNameForUrl(url) || this.hostForUrl(url);
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

    private cacheDeliveryContexts(sessions: Array<{ key?: string; deliveryContext?: any }>): void {
        for (const session of sessions) {
            const key = String(session?.key || '').trim();
            if (key && session?.deliveryContext && typeof session.deliveryContext === 'object') {
                this.deliveryContextBySession.set(key, session.deliveryContext);
            }
        }
    }

    private async resolveDeliveryContext(sessionKey: string): Promise<any | null> {
        if (!sessionKey) return null;
        const cached = this.deliveryContextBySession.get(sessionKey);
        if (cached) return cached;
        if (!this.gateway.capabilities.canListSessions()) return null;
        try {
            const res = await this.gateway.sendRequest('sessions.list', {});
            const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
            this.cacheDeliveryContexts(sessions);
            return this.deliveryContextBySession.get(sessionKey) ?? null;
        } catch (err) {
            Logger.getInstance().warn('OpenClaw resolveDeliveryContext failed', err);
            return null;
        }
    }

    private nativeReactionFor(channel: string, reaction: 'up' | 'down'): string {
        const normalized = channel.toLowerCase();
        if (normalized.includes('slack')) return reaction === 'up' ? 'thumbsup' : 'thumbsdown';
        if (normalized.includes('msteams') || normalized.includes('teams')) return reaction === 'up' ? 'like' : 'sad';
        return reaction === 'up' ? '👍' : '👎';
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

    async getSlashSuggestions(prefix: string): Promise<Array<{ name: string; description?: string }>> {
        await this.commandPalette.load(this.gateway, this.selection.agentId || 'main').catch((e) => Logger.getInstance().error('commandPalette.load failed', e));
        return this.commandPalette.getSuggestions(prefix);
    }

    getToolStatus(): ToolStatusView | null {
        return this.toolStatusManager.getStatus();
    }
}
