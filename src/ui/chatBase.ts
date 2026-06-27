import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { ToolEventHandler } from './toolEventHandler';
import { CheckpointManager } from '../checkpoints/checkpointManager';
import { BridgeRegistry } from '../bridges/registry';
import { BridgeMessageReactionTarget, BridgeSelectionState, ChatBridge, ChoiceMenuItem, VSCODE_WORKSPACE_CONTEXT_PREFIX, WORKSPACE_LINE_PREFIX_RE } from '../bridges/types';
import { parseSlashCommand } from '../bridges/slashCommands';
import { buildHiddenWorkspaceContext, hiddenContextKey } from '../bridges/hiddenContext';
import { normalizeBridgeError } from '../bridges/errors';
import { config } from '../config/agentBridgeConfig';
import { getCurrentSelection, SelectionData } from '../context/selection-tracker';
import {
    AttachedPill,
    TranscriptTurn,
    TranscriptTool,
    LEGACY_VSCODE_WORKSPACE_CONTEXT_PREFIX,
} from './chatTypes';
import { buildWebviewHtml } from './webview-base';
import { ConfigManager } from './config-manager';
import { HistoryManager } from './history-manager';
import { EventRouter, ChatBaseHandlers } from './event-router';
import { openJunctionSettings } from './settings';
import { t } from '../l10n';
import { captureBridgeDebug, captureRenderDebug } from '../utils/debugCapture';

/**
 * Shared logic for ChatViewProvider (sidebar) and ChatPanel (editor column).
 * Subclasses implement postToWebview() to route messages to their specific
 * webview surface.
 *
 * The webview UI is the modular shell under resources/webview/. The extension
 * side here is pure transport (stream events ↔ postMessage), composed from
 * smaller modules.
 */
export abstract class ChatBase {
    /** Unique ID for this view instance — prevents cross-window bleed. */
    protected readonly viewId = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    /** Session key this view is currently displaying — used to filter events. */
    protected viewSessionKey: string | null = null;
    /** True while a send is in flight on a view that has no session yet. */
    protected pendingSessionAdoption = false;

    protected activeRuns = new Map<string, string>();
    protected cachedHistory: Array<{ role: string; content: string; isSteer?: boolean }> = [];
    protected transcript: TranscriptTurn[] = [];
    protected runTurnIds = new Map<string, string>();
    protected completedRunIds = new Set<string>();
    protected fallbackRunCounter = 0;
    protected activeRunId: string | null = null;
    protected currentModelDisplay: string = '';
    protected checkpoints: CheckpointManager;
    protected thinkingBuffers = new Map<string, string>();
    protected thinkingStart = new Map<string, number>();
    protected pendingToolCallIds = new Map<string, Map<string, string[]>>();
    protected sessionTranscripts = new Map<string, TranscriptTurn[]>();
    protected currentThinking: string | undefined;
    protected currentAgentId: string | undefined;
    protected followUpMode: 'queue' | 'steer' | 'interrupt' = 'queue';
    protected pendingFollowUp: string[] = [];
    protected pendingFollowUpMessageIds: string[] = [];
    protected pendingFollowUpGroupWithPrevious: boolean[] = [];
    protected archivedKeys = new Set<string>();
    protected chatScope: 'folder' | 'all' = 'folder';
    protected sessionTitles = new Map<string, string>();
    protected attachedPills = new Map<string, AttachedPill>();
    protected livePillPath: string | null = null;
    protected currentModelId: string | undefined;
    protected pendingNewChat = false;
    protected injectedHiddenContexts = new Set<string>();
    protected debugQueueStall = false;
    protected debugQueueStallEnabled = true;

    /** Composed modules. */
    protected readonly configManager: ConfigManager;
    protected readonly historyManager: HistoryManager;
    protected readonly eventRouter: EventRouter;

    constructor(
        protected readonly extensionUri: vscode.Uri,
        protected readonly bridgeRegistry: BridgeRegistry
    ) {
        this.checkpoints = new CheckpointManager(bridgeRegistry.context);

        // Composed modules
        this.configManager = new ConfigManager(bridgeRegistry.context);
        this.historyManager = new HistoryManager(
            (prefix?: string) => this.makeMessageId(prefix),
            (role: string, content: string) => this.visibleTurnContent(role, content),
            (msg: any) => this.extractHistoryText(msg),
            (message: any) => this.postToWebview(message),
            () => this.renderBridgeConfig(),
        );
        this.eventRouter = new EventRouter(this.buildHandlerInterface());
        this.eventRouter.configManager = this.configManager;

        this.attachBridgeStreamListener(this.bridgeRegistry.active);
        this.attachReconnectListener(this.bridgeRegistry.active);
        this.bridgeRegistry.on('changed', (newBridge) => {
            this.detachBridgeStreamListener();
            this.detachReconnectListener();
            // Unwatch the old bridge's session before switching so stale events
            // from the previous gateway are gated at transport level.
            // NOTE: this.bridge already points to the new bridge by the time
            // 'changed' fires (registry sets activeId before emitting). The old
            // bridge is already disconnected — its watchedSessions don't matter
            // anymore. Just clear the view-level session tracking.
            this.viewSessionKey = null;
            this.pendingSessionAdoption = false;
            this.activeRunIdsBySession.clear();
            this.attachBridgeStreamListener(newBridge);
            this.attachReconnectListener(newBridge);
            this.cachedHistory = [];
            this.transcript = [];
            this.runTurnIds.clear();
            this.activeRuns.clear();
            this.completedRunIds.clear();
            this.activeRunId = null;
            this.currentModelDisplay = '';
            this.currentModelId = undefined;
            this.currentThinking = undefined;
            this.injectedHiddenContexts.clear();
            this.clearFollowUpQueue();
            this.postToWebview({ type: 'clearChat' });
            void this.handleInitRequest();
        });

        // Safety net: if webview posted initRequest before the ready handler fired
        setTimeout(() => {
            void this.handleInitRequest();
        }, 500);

        // Live look-and-feel: re-push config and repaint when stream-display settings change
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (ConfigManager.affectsChatConfig(e)) {
                this.sendConfig();
                this.renderTranscript();
            }
        });
        vscode.window.onDidChangeActiveColorTheme(() => {
            this.sendConfig();
        });
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.sendConfig();
        });
    }

    /**
     * Build the handler interface for the EventRouter — maps each event type
     * to the corresponding ChatBase method reference.
     */
    private buildHandlerInterface(): ChatBaseHandlers {
        return {
            handleInitRequest: () => this.handleInitRequest(),
            handleUserMessage: (text, dispatchOverride) => this.handleUserMessage(text, dispatchOverride),
            handleStopRun: () => this.handleStopRun(),
            handleAttachFile: () => this.handleAttachFile(),
            handleAttachPastedFile: (data) => this.handleAttachPastedFile(data),
            handleSlashComplete: (prefix) => this.handleSlashComplete(prefix),
            handleCreateChat: (text) => this.handleCreateChat(text),
            handleNewChatThenSend: (text) => this.handleNewChatThenSend(text),
            handleResumeSession: (key) => this.handleResumeSession(key),
            handleViewSessionList: () => this.handleViewSessionList(),
            handleRenameSession: (key, label) => this.handleRenameSession(key, label),
            handleArchiveSession: (key) => this.handleArchiveSession(key),
            handleShowArchived: (show) => this.handleShowArchived(show),
            handleSetChatScope: (scope) => this.handleSetChatScope(scope),
            handleRestoreNavigation: (state) => this.handleRestoreNavigation(state),
            handleRequestTaskHistory: (scope) => this.handleRequestTaskHistory(scope),
            handleRequestModelChoices: () => this.handleRequestModelChoices(),
            handleSelectModelChoice: (data) => this.handleSelectModelChoice(data),
            handleRequestReasoningChoices: () => this.handleRequestReasoningChoices(),
            handleSelectReasoningChoice: (data) => this.handleSelectReasoningChoice(data),
            handleRequestEnvironmentChoices: () => this.handleRequestEnvironmentChoices(),
            handleSelectEnvironmentChoice: (data) => this.handleSelectEnvironmentChoice(data),
            handleRequestSandboxChoices: () => this.handleRequestSandboxChoices(),
            handleSelectSandboxChoice: (data) => this.handleSelectSandboxChoice(data),
            handleHeaderAction: (data) => this.handleHeaderAction(data),
            handleListWorkspaceFiles: (prefix) => this.handleListWorkspaceFiles(prefix),
            addFilePill: (uri) => this.addFilePill(uri),
            handleAddPill: (data) => this.handleAddPill(data),
            handleRemovePill: (filePath) => this.handleRemovePill(filePath),
            handleToggleLivePill: (enabled) => this.handleToggleLivePill(enabled),
            handleEditQueuedFollowUp: (index, text) => this.handleEditQueuedFollowUp(index, text),
            handleMoveQueuedFollowUp: (index, direction) => this.handleMoveQueuedFollowUp(index, direction),
            handleReorderQueuedFollowUps: (order) => this.handleReorderQueuedFollowUps(order),
            handleToggleQueuedFollowUpGroup: (index) => this.handleToggleQueuedFollowUpGroup(index),
            handleSteerQueuedFollowUp: (index, id) => this.handleSteerQueuedFollowUp(index, id),
            handleRemoveQueuedFollowUp: (index) => this.handleRemoveQueuedFollowUp(index),
            handleLoadMoreHistory: () => this.handleLoadMoreHistory(),
            handleLoadMoreHistoryFromJsonl: (offset) => this.handleLoadMoreHistoryFromJsonl(offset),
            handleOpenSettings: () => this.handleOpenSettings(),
            handleGetUsage: () => this.handleGetUsage(),
            handleForkConversation: (messageId) => this.handleForkConversation(messageId),
            handleForkAndRewind: (messageId) => this.handleForkAndRewind(messageId),
            handleRewindToMessage: (messageId) => this.handleRewindToMessage(messageId),
            handleReviewCheckpointDiff: (messageId, files) => this.handleReviewCheckpointDiff(messageId, files),
            handleOpenFile: (filePath) => this.handleOpenFile(filePath),
            handleSetReaction: (messageId, value) => this.handleSetReaction(messageId, value),
            handleApprovalRespond: (data) => this.handleApprovalRespond(data),
            handleInputRespond: (data) => this.handleInputRespond(data),
            handleCompactContext: () => this.handleCompactContext(),
            handleSetDebugQueueStall: (stall) => this.handleSetDebugQueueStall(stall),
            postToWebview: (message) => this.postToWebview(message),
        };
    }

    protected get bridge() {
        return this.bridgeRegistry.active;
    }

    /** Bound stream handler reference for clean attach/detach. */
    private _streamHandler?: (event: any) => void;
    private _streamBridge?: ChatBridge;
    private _reconnectHandler?: () => void;
    private _reconnectBridge?: ChatBridge;

    private attachBridgeStreamListener(bridge?: ChatBridge): void {
        const target = bridge || this.bridgeRegistry.active;
        this._streamHandler = (event: any) => {
            event._bridgeId = target.id;
            if (!event.sessionKey) {
                // Do NOT stamp with bridge.getCurrentSessionKey() — that is a
                // per-folder shared mutable in SessionManager and can point to a
                // session owned by a different view, causing cross-session bleed.
                // Use this view's own adopted session instead.  If the view has no
                // session yet the event will be dropped by handleStreamEvent's
                // viewSessionKey guard, which is the correct outcome.
                if (this.viewSessionKey) {
                    event.sessionKey = this.viewSessionKey;
                }
            }
            this.handleStreamEvent(event);
        };
        this._streamBridge = target;
        target.on('stream', this._streamHandler);
    }

    private detachBridgeStreamListener(): void {
        if (this._streamHandler && this._streamBridge) {
            this._streamBridge.removeListener('stream', this._streamHandler);
            this._streamHandler = undefined;
            this._streamBridge = undefined;
        }
    }

    private attachReconnectListener(bridge?: ChatBridge): void {
        const target = bridge || this.bridgeRegistry.active;
        this._reconnectHandler = async () => {
            this.injectedHiddenContexts.clear();
            const sessionKey = this.bridge.getCurrentSessionKey();
            if (sessionKey) {
                this.adoptViewSession(sessionKey);
                const dispatchContext = await this.gatherContext();
                await this.ensureHiddenWorkspaceContext(sessionKey, dispatchContext).catch(() => false);
            }
            await this.historyManager.restoreHistory(
                this.bridge,
                this.transcript,
                (turns, historyItems) => {
                    this.transcript = turns;
                    this.cachedHistory = historyItems;
                }
            );
            if (this.activeRunId) {
                const stillActive = this.activeRuns.has(this.activeRunId);
                if (!stillActive) {
                    this.finalizeRun(this.activeRunId);
                }
            }
        };
        this._reconnectBridge = target;
        target.on('reconnected', this._reconnectHandler);
    }

    private detachReconnectListener(): void {
        if (this._reconnectHandler && this._reconnectBridge) {
            this._reconnectBridge.removeListener('reconnected', this._reconnectHandler);
            this._reconnectHandler = undefined;
            this._reconnectBridge = undefined;
        }
    }

    /** Send a message to the underlying webview. Subclasses implement this. */
    protected abstract postToWebview(message: any): void;

    protected captureWebviewMessage(message: any): void {
        const type = String(message?.type ?? '');
        if (!this.isChatDebugWebviewMessage(type)) return;
        const summary = summarizeWebviewMessage(message);
        Logger.getInstance().captureDebugStream('chat-webview', {
            bridgeId: this.bridgeRegistry.active.id,
            sessionKey: this.viewSessionKey ?? this.bridge.getCurrentSessionKey?.(),
            message,
        });
        captureRenderDebug(type, {
            bridgeId: this.bridgeRegistry.active.id,
            sessionKey: this.viewSessionKey ?? this.bridge.getCurrentSessionKey?.(),
            ...this.renderBridgeConfig(),
            ...summary,
        });
    }

    private isChatDebugWebviewMessage(type: string): boolean {
        return type === 'history'
            || type === 'switchToChat'
            || type === 'moreHistory'
            || type === 'userEcho'
            || type === 'response'
            || type === 'assistant_stream_start'
            || type === 'assistant_stream_delta'
            || type === 'assistant_stream_end'
            || type === 'thinking_chunk'
            || type === 'thinking_end'
            || type === 'tool_start'
            || type === 'tool_update'
            || type === 'tool_result'
            || type === 'subagentInfo'
            || type === 'runActive'
            || type === 'runComplete';
    }

    /**
     * Assemble the modular webview HTML. Delegates to webview-base.
     */
    protected buildHtml(webview: vscode.Webview): string {
        return buildWebviewHtml(this.extensionUri, webview);
    }

    /** Wire up message handler for the given webview. Delegates to EventRouter. */
    protected wireMessageHandler(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (data) => {
            await this.eventRouter.handleMessage(data);
        });
    }

    // ── session adoption ────────────────────────────────────────────────

    protected adoptViewSession(key: string | null): void {
        const next = key ? String(key).trim() || null : null;
        if (this.viewSessionKey === next) {
            if (next) this.bridge.watchSession?.(next);
            return;
        }
        // Save current transcript before switching sessions
        if (this.viewSessionKey) {
            this.persistCurrentTranscript();
            this.bridge.unwatchSession?.(this.viewSessionKey);
        }
        this.viewSessionKey = next;
        if (next) this.bridge.watchSession?.(next);
        const running = !!(next && this.activeRunIdsBySession.get(next));
        this.activeRunId = next ? (this.activeRunIdsBySession.get(next) ?? null) : null;
        // Restore transcript for the new session from cache
        if (next) this.restoreTranscriptFromCache(next);
        this.postToWebview({ type: 'runActive', active: running, sessionKey: next ?? undefined });
    }

    protected rememberSessionWorkspace(sessionKey: string | null | undefined, folderUri?: vscode.Uri): void {
        this.bridge.bindSessionWorkspace?.(sessionKey, folderUri);
    }

    protected boundSessionWorkspace(sessionKey: string | null | undefined): vscode.Uri | undefined {
        return this.bridge.boundSessionWorkspace?.(sessionKey);
    }

    protected async ensureHiddenWorkspaceContext(sessionKey: string | null | undefined, context: any): Promise<boolean> {
        const key = String(sessionKey || '').trim();
        if (!key) return false;
        const bridgeContext = {
            workspace: context?.workspace,
            workspaceFolder: context?.workspaceFolder,
            activeFile: context?.activeFile,
            language: context?.language,
            selection: context?.selection,
        };
        const message = buildHiddenWorkspaceContext(bridgeContext);
        if (!message) return false;
        const marker = hiddenContextKey(key, bridgeContext);
        if (this.injectedHiddenContexts.has(marker)) return true;
        let ok = false;
        try {
            if (typeof this.bridge.injectHiddenContext === 'function') {
                ok = await this.bridge.injectHiddenContext(key, bridgeContext, message);
            } else if (this.bridge.canAdminInject() || this.bridge.canSteer()) {
                ok = await this.bridge.injectMessage(key, message);
            }
        } catch (err) {
            Logger.getInstance().warn('hidden workspace context injection failed', err);
        }
        if (ok) this.injectedHiddenContexts.add(marker);
        return ok;
    }

    protected async listBridgeSessions(scope: 'folder' | 'all', includeArchived = false): Promise<any[]> {
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (typeof this.bridge.listWorkspaceSessions === 'function') {
            return this.bridge.listWorkspaceSessions(scope, includeArchived, this.archivedKeys, currentFolder);
        }
        return this.bridge.listSessions(scope, includeArchived, this.archivedKeys);
    }

    // ─── helpers ───────────────────────────────────────────────────────────

    protected getSendBehavior(): 'enter' | 'ctrlEnter' | 'smartEnter' {
        return this.configManager.getSendBehavior();
    }

    protected defaultChatTitle(): string {
        return vscode.workspace.workspaceFolders?.[0]?.name || 'Chat';
    }

    protected sessionTitle(key: string | null | undefined): string {
        if (!key) return this.defaultChatTitle();
        return this.sessionTitles.get(key) || this.defaultChatTitle();
    }

    protected rememberSessionTitles(sessions: Array<{ key: string; title?: string }>): void {
        for (const session of sessions) {
            if (session.key && session.title) this.sessionTitles.set(session.key, session.title);
        }
    }

    protected makeMessageId(prefix = 'm'): string {
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    }

    protected deriveChatTitle(text: string): string {
        const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const line = lines.find((l) => !/^Treat this as/i.test(l)) || lines[0] || '';
        const clean = line.replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        return clean.length > 48 ? clean.slice(0, 47).trimEnd() + '…' : clean;
    }

    protected visibleTurnContent(role: string, content: string): string | null {
        const text = String(content || '');
        const trimmed = text.trim();
        if (role === 'user') {
            const visible = this.stripWorkspaceContextBlock(text).replace(WORKSPACE_LINE_PREFIX_RE, '');
            return visible.trim() ? visible : null;
        }
        if (
            trimmed.startsWith(VSCODE_WORKSPACE_CONTEXT_PREFIX) ||
            trimmed.startsWith(LEGACY_VSCODE_WORKSPACE_CONTEXT_PREFIX) ||
            trimmed.startsWith('[Workspace File Context]') ||
            trimmed.startsWith('[Attached Context]') ||
            trimmed.includes('treat paths as relative to workspace') ||
            (trimmed.includes('workspace:') && trimmed.includes('treat paths'))
        ) {
            return null;
        }
        return text;
    }

    protected buildWorkspaceContextBlock(context: any): string {
        const workspace = String(context?.workspaceFolder ?? context?.workspace ?? '').trim();
        if (!workspace) return '';
        return [
            VSCODE_WORKSPACE_CONTEXT_PREFIX,
            `workspace: ${workspace}`,
            'treat paths as relative to workspace.',
        ].join('\n');
    }

    protected stripWorkspaceContextBlock(text: string): string {
        let out = String(text || '');
        const canonical = new RegExp(
            '^' +
            VSCODE_WORKSPACE_CONTEXT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\r?\\nworkspace: [^\\r\\n]*\\r?\\ntreat paths as relative to workspace\\.\\r?\\n\\r?\\n?',
            'i',
        );
        let prev = '';
        while (prev !== out) {
            prev = out;
            out = out.replace(canonical, '');
        }
        if (out.trim().startsWith(LEGACY_VSCODE_WORKSPACE_CONTEXT_PREFIX)) return '';
        return out;
    }

    protected withWorkspaceContext(text: string, context: any): string {
        const block = this.buildWorkspaceContextBlock(context);
        if (!block) return text;
        const stripped = this.stripWorkspaceContextBlock(text);
        return `${block}\n\n${stripped}`;
    }

    protected cloneTranscript(turns: TranscriptTurn[]): TranscriptTurn[] {
        return this.historyManager.cloneTranscript(turns);
    }

    protected persistCurrentTranscript(): void {
        this.historyManager.persistCurrentTranscript(
            this.sessionTranscripts,
            this.bridge,
            this.transcript
        );
    }

    protected restoreTranscriptFromCache(key: string): boolean {
        const result = this.historyManager.restoreTranscriptFromCache(
            key,
            this.sessionTranscripts,
            this.transcript,
            this.runTurnIds,
            this.activeRuns,
            () => this.renderTranscript()
        );
        if (!result) return false;
        this.transcript = result.transcript;
        this.runTurnIds = result.runTurnIds;
        this.activeRuns = result.activeRuns;
        this.renderTranscript();
        return true;
    }

    protected extractHistoryText(msg: any): string {
        const content = msg?.text ?? msg?.content ?? msg?.message?.text ?? msg?.message?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (typeof part?.text === 'string') return part.text;
                    if (typeof part?.content === 'string') return part.content;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        if (content && typeof content === 'object') {
            if (typeof content.text === 'string') return content.text;
            if (typeof content.content === 'string') return content.content;
        }
        return '';
    }

    protected historyMessages(): Array<{ role: string; content: string; messageId?: string; hasCheckpoint?: boolean; reaction?: 'up' | 'down' | null; reactionTarget?: BridgeMessageReactionTarget }> {
        const messages = this.historyManager.historyMessages(this.transcript);
        const messageReactions = this.supportsMessageReactions();
        const displayMessages = messages.map((message) => {
            if (!messageReactions && (message.reaction || message.reactionTarget)) return { ...message, reaction: undefined, reactionTarget: undefined };
            return message;
        });
        if (!this.hidesRawThinking()) return displayMessages;
        return displayMessages.map((message) => {
            if (message.role !== 'assistant' || !message.thinking) return message;
            return {
                ...message,
                thinking: undefined,
                thinkingComplete: undefined,
                thinkingDurationMs: undefined,
            };
        });
    }

    protected renderTranscript(): void {
        this.historyManager.renderTranscript(this.transcript);
    }

    public repaintTranscript(): void {
        this.renderTranscript();
    }

    public async sendText(text: string): Promise<void> {
        if (text.trim()) await this.handleUserMessage(text);
    }

    protected appendUserTurn(text: string, messageId: string, isSteer?: boolean): void {
        this.transcript.push({ id: messageId, role: 'user', content: text, messageId, hasCheckpoint: false, isSteer });
        this.cachedHistory.push({ role: 'user', content: text, isSteer });
        this.postToWebview({ type: 'userEcho', text, messageId, hasCheckpoint: false, isSteer });
        this.persistCurrentTranscript();
    }

    protected isTerminalLifecyclePhase(phase: unknown): boolean {
        return this.historyManager.isTerminalLifecyclePhase(phase);
    }

    /** Active run IDs scoped by session — prevents cross-chat bleed. */
    private activeRunIdsBySession = new Map<string, string>();

    protected resolveRunId(event: any, prefix: string): string {
        const direct = String(event?.runId ?? '').trim();
        if (direct) return direct;
        const session = String(event?.sessionKey ?? this.bridge.getCurrentSessionKey() ?? '').trim();
        if (session && this.activeRunIdsBySession.has(session)) {
            return this.activeRunIdsBySession.get(session)!;
        }
        if (this.activeRunId) return this.activeRunId;
        if (session) return `${prefix}:${session}`;
        return `${prefix}:fallback:${++this.fallbackRunCounter}`;
    }

    protected ensureAssistantTurn(runId: string): TranscriptTurn {
        const existingId = this.runTurnIds.get(runId);
        const existing = existingId ? this.transcript.find((turn) => turn.id === existingId) : undefined;
        if (existing) return existing;

        const id = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const turn: TranscriptTurn = { id, role: 'assistant', content: '', runId, messageId: id };
        this.transcript.push(turn);
        this.runTurnIds.set(runId, id);
        this.postToWebview({ type: 'assistant_stream_start', runId, messageId: id });
        this.persistCurrentTranscript();
        return turn;
    }

    protected updateAssistantTurn(runId: string, text: string, commandOutput?: any): void {
        const turn = this.ensureAssistantTurn(runId);
        turn.content = text;
        this.activeRuns.set(runId, text);
        this.cachedHistory = this.cachedHistory.filter(i => i.role !== 'assistant:' + runId);
        this.cachedHistory.push({ role: 'assistant:' + runId, content: text });
        this.postToWebview({ type: 'assistant_stream_delta', runId, fullText: text, commandOutput });
        this.persistCurrentTranscript();
    }

    protected extractReactionTarget(event: any): BridgeMessageReactionTarget | undefined {
        // Capture ONLY the irreducible per-message identity (the native gateway
        // message id + its session). The delivery context — channel, recipient,
        // accountId — is NOT embedded per message; it is resolved lazily by the
        // bridge when (and only when) a vote button is actually pressed, since the
        // overwhelming majority of messages never receive feedback.
        const raw = event?.reactionTarget || event?.nativeReactionTarget || event?.deliveryTarget || {};
        const nativeMessageId = raw.nativeMessageId ?? raw.messageId ?? event?.nativeMessageId ?? event?.sourceMessageId ?? event?.messageId;
        const sessionKey = raw.sessionKey ?? event?.sessionKey;
        const target: BridgeMessageReactionTarget = {};
        if (typeof sessionKey === 'string' && sessionKey.trim()) target.sessionKey = sessionKey.trim();
        if (typeof nativeMessageId === 'string' && nativeMessageId.trim()) target.nativeMessageId = nativeMessageId.trim();
        return Object.keys(target).length ? target : undefined;
    }

    protected mergeReactionTarget(runId: string, event: any): void {
        const target = this.extractReactionTarget(event);
        if (!target) return;
        const turn = this.ensureAssistantTurn(runId);
        turn.reactionTarget = { ...(turn.reactionTarget ?? {}), ...target };
    }

    protected markCheckpoint(messageId: string, hasCheckpoint: boolean): void {
        const turn = this.transcript.find((item) => item.messageId === messageId);
        if (turn) turn.hasCheckpoint = hasCheckpoint;
        if (hasCheckpoint) this.postToWebview({ type: 'checkpointReady', messageId });
        this.persistCurrentTranscript();
    }

    protected sendConfig(): void {
        this.postToWebview({
            ...this.configManager.buildConfigPayload(),
            activeBridge: this.bridgeRegistry.active.id,
            messageReactions: this.supportsMessageReactions(),
            interleaveTimeline: !!this.bridgeRegistry.active.capabilities.timelineInterleaves,
            debugQueueStallEnabled: this.debugQueueStallEnabled,
        });
        // Also push debug stall state
        this.sendDebugQueueStallState();
        this.sendDebugQueueStallOverride();
    }

    protected sendDebugQueueStallState(): void {
        this.postToWebview({ type: 'debugQueueStallState', stalled: this.debugQueueStall });
    }

    protected sendDebugQueueStallOverride(): void {
        this.postToWebview({ type: 'debugQueueStallOverride', debugMode: this.debugQueueStallEnabled, stalled: this.debugQueueStall });
    }

    protected renderBridgeConfig(): { activeBridge: string; sessionKey?: string; interleaveTimeline: boolean; compactTimelineMode: boolean } {
        return {
            activeBridge: this.bridgeRegistry.active.id,
            sessionKey: this.viewSessionKey ?? this.bridge.getCurrentSessionKey?.() ?? undefined,
            interleaveTimeline: !!this.bridgeRegistry.active.capabilities.timelineInterleaves,
            compactTimelineMode: config().get<boolean>('compactTimelineMode', false),
        };
    }

    // ── handlers ───────────────────────────────────────────────────────────

    protected async handleInitRequest(): Promise<void> {
        this.sendConfig();
        this.pushModelDisplay();
        this.pushSandboxDisplay();
        this.refreshFollowUpMode();
        this.pushEnvLabel();
        this.pushScopeLabel();
        this.pushAttachedPills();
        this.pushFollowUpQueue();
        try { await this.bridge.connect(); } catch (e) { /* already connected */ }
        const lastKey = this.bridge.getCurrentSessionKey();
        if (lastKey) {
            this.rememberSessionWorkspace(lastKey, vscode.workspace.workspaceFolders?.[0]?.uri);
            this.adoptViewSession(lastKey);
        }
        this.hydrateModelSelection();
        await this.refreshModelDisplayFromChoices();
        const title = this.defaultChatTitle();
        this.postToWebview({ type: 'switchToChat', title, history: this.historyMessages(), ...this.renderBridgeConfig() });
        this.postToWebview({ type: 'history', messages: this.historyMessages(), ...this.renderBridgeConfig() });
        await this.historyManager.restoreHistory(
            this.bridge,
            this.transcript,
            (turns, historyItems) => {
                this.transcript = turns;
                this.cachedHistory = historyItems;
            }
        );
        const sessionKey = this.bridge.getCurrentSessionKey();
        if (sessionKey) {
            const activeRunId = this.activeRunIdsBySession.get(sessionKey) || (this.activeRunId ? this.activeRunId : null);
            if (activeRunId) {
                this.postToWebview({ type: 'runActive', runId: activeRunId, active: true });
            }
        }
        await this.pushSessions();
        if (sessionKey) {
            this.postToWebview({ type: 'updateTitle', key: sessionKey, title: this.sessionTitle(sessionKey) });
        }
    }

    protected async handleViewSessionList(): Promise<void> {
        await this.pushSessions();
        this.postToWebview({ type: 'switchToHome', ...this.renderBridgeConfig() });
    }

    /** Public-facing wrapper for ChatViewProvider compatibility. */
    protected async restoreHistory(): Promise<void> {
        await this.historyManager.restoreHistory(
            this.bridge,
            this.transcript,
            (turns, historyItems) => {
                this.transcript = turns;
                this.cachedHistory = historyItems;
            }
        );
    }

    protected async handleCreateChat(text?: string): Promise<void> {
        await this.handleNewChat();
        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: [], ...this.renderBridgeConfig() });
        if (text && text.trim()) {
            await this.handleUserMessage(text);
        }
        await this.pushSessions();
    }

    protected async handleNewChatThenSend(text: string): Promise<void> {
        await this.handleCreateChat(text);
    }

    protected async handleResumeSession(key: string): Promise<void> {
        if (!key) return;
        Logger.sessionDebug(this.bridgeRegistry.context, { op: 'resumeSession', key, viewSessionKey: this.viewSessionKey, activeSessionId: this.bridge.getCurrentSessionKey()?.toString() });
        this.persistCurrentTranscript();
        const folderUri = this.bridge.getSessionToFolder().get(key)
            ?? this.boundSessionWorkspace(key)
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (folderUri) this.bridge.setActiveSession(folderUri, key);
        this.rememberSessionWorkspace(key, folderUri);
        this.adoptViewSession(key);
        this.cachedHistory = [];
        this.transcript = [];
        this.runTurnIds.clear();
        this.activeRuns.clear();
        this.completedRunIds.clear();
        this.pendingNewChat = false;
        const title = this.sessionTitle(key);
        this.postToWebview({ type: 'switchToChat', title, history: [], ...this.renderBridgeConfig() });
        this.postToWebview({ type: 'updateTitle', key, title });
        Logger.sessionDebug(this.bridgeRegistry.context, { op: 'resumeSession.postSwitch', viewSessionKey: this.viewSessionKey });
        await this.ensureHiddenWorkspaceContext(key, await this.gatherContext()).catch(() => false);
        if (this.restoreTranscriptFromCache(key)) {
            Logger.sessionDebug(this.bridgeRegistry.context, { op: 'resumeSession.cacheHit', key });
            return;
        }
        Logger.sessionDebug(this.bridgeRegistry.context, { op: 'resumeSession.restoreHistory', key });
        await this.historyManager.restoreHistory(
            this.bridge,
            this.transcript,
            (turns, historyItems) => {
                this.transcript = turns;
                this.cachedHistory = historyItems;
            }
        );
    }

    protected async handleRenameSession(key: string, label: string): Promise<void> {
        if (!key || !label) return;
        try { await this.bridge.renameSession(key, label); }
        catch (err) { Logger.getInstance().warn('rename session failed', err); }
        this.sessionTitles.set(key, label);
        this.postToWebview({ type: 'updateTitle', key, title: label });
        await this.pushSessions();
    }

    protected async handleArchiveSession(key: string): Promise<void> {
        if (!key) return;
        this.archivedKeys.add(key);
        await this.pushSessions();
        await this.handleViewSessionList();
    }

    protected async handleShowArchived(show: boolean): Promise<void> {
        await this.pushSessions(show);
    }

    protected async handleSetChatScope(scope: string): Promise<void> {
        this.chatScope = scope === 'all' ? 'all' : 'folder';
        this.pushScopeLabel();
        await this.pushSessions();
    }

    protected async handleRestoreNavigation(state: any): Promise<void> {
        const bridgeId = String(state?.bridgeId ?? '').trim();
        const sessionKey = String(state?.sessionKey ?? '').trim();
        const view = state?.view === 'home' ? 'home' : 'chat';

        if (bridgeId && bridgeId !== this.bridgeRegistry.active.id) {
            try {
                await this.bridgeRegistry.setActive(bridgeId);
            } catch (err) {
                Logger.getInstance().warn('restore navigation bridge switch failed', { bridgeId, err });
            }
        }

        if (view === 'home') {
            await this.handleViewSessionList();
            return;
        }
        if (sessionKey) {
            await this.handleResumeSession(sessionKey);
            return;
        }
        await this.handleInitRequest();
    }

    protected async handleRequestTaskHistory(scope: string): Promise<void> {
        const nextScope: 'folder' | 'all' = scope === 'all' ? 'all' : 'folder';
        if (!this.bridge.capabilities.sessions) {
            this.postToWebview({ type: 'renderTaskHistory', scope: nextScope, groups: [], activeKey: undefined });
            return;
        }
        try {
            const sessions = await this.listBridgeSessions(nextScope, false);
            this.rememberSessionTitles(sessions);
            const groups = this.historyManager.buildSessionGroups(sessions);
            const activeKey = this.bridge.getCurrentSessionKey() ?? undefined;
            this.postToWebview({ type: 'renderTaskHistory', scope: nextScope, groups, activeKey });
        } catch (err) {
            Logger.getInstance().warn('request task history failed', err);
            this.postToWebview({ type: 'renderTaskHistory', scope: nextScope, groups: [], activeKey: undefined });
        }
    }

    protected pushScopeLabel(): void {
        let label: string;
        if (this.chatScope === 'all') {
            label = t('All chats');
        } else {
            const folder = vscode.workspace.workspaceFolders?.[0];
            label = folder ? folder.name : 'This folder';
        }
        this.postToWebview({ type: 'chatScopeLabel', label, scope: this.chatScope });
    }

    protected async pushSessions(includeArchived = false): Promise<void> {
        try {
            if (!this.bridge.capabilities.sessions) return;
            const sessions = await this.listBridgeSessions(this.chatScope, includeArchived);
            const groups = this.historyManager.buildSessionGroups(sessions);
            const activeKey = this.bridge.getCurrentSessionKey() ?? undefined;
            this.postToWebview({ type: 'renderSessions', groups, activeKey, ...this.renderBridgeConfig() });
            this.rememberSessionTitles(sessions);
        } catch (err) {
            Logger.getInstance().warn('pushSessions failed', err);
        }
    }

    protected async handleOpenSettings(): Promise<void> {
        await openJunctionSettings();
    }

    // ── webview choice menus ──────────────────────────────────────────────────

    protected async handleHeaderAction(data: any): Promise<void> {
        switch (data.id) {
            case 'rename':
                this.postToWebview({ type: 'startRename' });
                break;
            case 'back':
                await this.handleViewSessionList();
                break;
            case 'usage':
                await this.handleGetUsage();
                break;
            case 'archive':
                await this.handleArchiveSession(String(data.key ?? this.bridge.getCurrentSessionKey() ?? ''));
                break;
            case 'settings':
                await this.handleOpenSettings();
                break;
            case 'agentPicker':
                await this.handleRequestAgentChoices();
                break;
            case 'fork':
                await this.handleForkConversation();
                break;
        }
    }

    protected async handleRequestReasoningChoices(): Promise<void> {
        let items: ChoiceMenuItem[] = [];
        try {
            if (this.bridge.capabilities.models) {
                const choices = await this.bridge.listModelChoices(this.currentModelId, this.currentThinking);
                const current = this.findCurrentModelChoice(choices);
                items = (current?.children ?? []).map((level): ChoiceMenuItem => {
                    const effort = String(level.thinking ?? level.id);
                    return {
                        id: effort,
                        label: level.label || effort,
                        description: 'Reasoning effort',
                        checked: effort === this.currentThinking,
                    };
                });
            }
        } catch (err) {
            Logger.getInstance().warn('reasoning choices failed', err);
        }
        this.postToWebview({ type: 'reasoningChoices', items });
    }

    protected findCurrentModelChoice(choices: ChoiceMenuItem[]): ChoiceMenuItem | undefined {
        const visit = (items: ChoiceMenuItem[]): ChoiceMenuItem | undefined => {
            for (const item of items) {
                if (item.id === this.currentModelId || item.model === this.currentModelId || item.checked) return item;
                if (Array.isArray(item.children)) {
                    const found = visit(item.children);
                    if (found) return found;
                }
            }
            return undefined;
        };
        return visit(choices);
    }

    protected async handleSelectReasoningChoice(data: any): Promise<void> {
        const effort = String(data.value ?? data.id ?? data.label ?? '').trim();
        if (!effort) return;
        this.currentThinking = effort;
        this.bridge.setSelection({ thinking: effort });
        this.persistModelSelection();
        this.pushModelDisplay();
    }

    protected refreshFollowUpMode(): void {
        this.followUpMode = this.configManager.getFollowUpMode(this.bridge?.id || '');
    }

    protected pushFollowUpQueue(): void {
        if (this.pendingFollowUpGroupWithPrevious.length > 0) {
            this.pendingFollowUpGroupWithPrevious[0] = false;
        }
        this.postToWebview({
            type: 'queueState',
            items: this.pendingFollowUp.map((text, index) => ({
                id: this.pendingFollowUpMessageIds[index] || String(index),
                index,
                text,
                groupWithPrevious: !!this.pendingFollowUpGroupWithPrevious[index],
                canSteer: this.bridge.canSteer(),
            })),
        });
    }

    protected enqueueFollowUp(text: string, messageId: string): void {
        this.pendingFollowUp.push(text);
        this.pendingFollowUpMessageIds.push(messageId);
        this.pendingFollowUpGroupWithPrevious.push(false);
        this.postToWebview({ type: 'queuedUserAdded', messageId });
        this.pushFollowUpQueue();
    }

    protected clearFollowUpQueue(): void {
        this.pendingFollowUp = [];
        this.pendingFollowUpMessageIds = [];
        this.pendingFollowUpGroupWithPrevious = [];
        this.pushFollowUpQueue();
    }

    protected dequeueFollowUp(): string | null {
        if (this.pendingFollowUp.length === 0) return null;
        const parts = [this.pendingFollowUp.shift() || ''];
        const activatedIds = [this.pendingFollowUpMessageIds.shift()].filter(Boolean) as string[];
        this.pendingFollowUpGroupWithPrevious.shift();
        while (this.pendingFollowUp.length > 0 && this.pendingFollowUpGroupWithPrevious[0]) {
            parts.push(this.pendingFollowUp.shift() || '');
            const id = this.pendingFollowUpMessageIds.shift();
            if (id) activatedIds.push(id);
            this.pendingFollowUpGroupWithPrevious.shift();
        }
        if (this.pendingFollowUpGroupWithPrevious.length > 0) {
            this.pendingFollowUpGroupWithPrevious[0] = false;
        }
        activatedIds.forEach((messageId) => this.postToWebview({ type: 'queuedUserActivated', messageId }));
        this.pushFollowUpQueue();
        return parts.filter(Boolean).join('\n\n') || null;
    }

    protected handleEditQueuedFollowUp(index: number, text: string): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.pendingFollowUp.length) return;
        const next = text.trim();
        if (!next) return;
        this.pendingFollowUp[index] = next;
        const messageId = this.pendingFollowUpMessageIds[index];
        const turn = this.transcript.find((item) => item.messageId === messageId);
        if (turn) turn.content = next;
        this.postToWebview({ type: 'queuedUserUpdated', messageId, text: next });
        this.persistCurrentTranscript();
        this.pushFollowUpQueue();
    }

    protected handleMoveQueuedFollowUp(index: number, direction: 'up' | 'down'): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.pendingFollowUp.length) return;
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= this.pendingFollowUp.length) return;
        const swap = <T>(arr: T[]) => {
            const tmp = arr[index];
            arr[index] = arr[nextIndex];
            arr[nextIndex] = tmp;
        };
        swap(this.pendingFollowUp);
        swap(this.pendingFollowUpMessageIds);
        swap(this.pendingFollowUpGroupWithPrevious);
        if (this.pendingFollowUpGroupWithPrevious.length > 0) {
            this.pendingFollowUpGroupWithPrevious[0] = false;
        }
        this.pushFollowUpQueue();
    }

    protected handleReorderQueuedFollowUps(order: string[]): void {
        if (!Array.isArray(order) || order.length === 0) return;
        const byId = new Map<string, number>();
        this.pendingFollowUpMessageIds.forEach((id, index) => byId.set(id, index));
        const seen = new Set<number>();
        const nextText: string[] = [];
        const nextIds: string[] = [];
        const nextGroups: boolean[] = [];
        for (const id of order) {
            const index = byId.get(id);
            if (index === undefined || seen.has(index)) continue;
            seen.add(index);
            nextText.push(this.pendingFollowUp[index]);
            nextIds.push(this.pendingFollowUpMessageIds[index]);
            nextGroups.push(this.pendingFollowUpGroupWithPrevious[index]);
        }
        this.pendingFollowUp.forEach((text, index) => {
            if (seen.has(index)) return;
            nextText.push(text);
            nextIds.push(this.pendingFollowUpMessageIds[index]);
            nextGroups.push(this.pendingFollowUpGroupWithPrevious[index]);
        });
        if (nextText.length !== this.pendingFollowUp.length) return;
        this.pendingFollowUp = nextText;
        this.pendingFollowUpMessageIds = nextIds;
        this.pendingFollowUpGroupWithPrevious = nextGroups;
        if (this.pendingFollowUpGroupWithPrevious.length > 0) {
            this.pendingFollowUpGroupWithPrevious[0] = false;
        }
        this.pushFollowUpQueue();
    }

    protected handleToggleQueuedFollowUpGroup(index: number): void {
        if (!Number.isInteger(index) || index <= 0 || index >= this.pendingFollowUp.length) return;
        this.pendingFollowUpGroupWithPrevious[index] = !this.pendingFollowUpGroupWithPrevious[index];
        this.pushFollowUpQueue();
    }

    protected async handleSteerQueuedFollowUp(index: number, id?: string): Promise<void> {
        let targetIndex = index;
        if (id) {
            const byId = this.pendingFollowUpMessageIds.indexOf(id);
            if (byId >= 0) targetIndex = byId;
        }
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.pendingFollowUp.length) return;
        const sessionKey = this.viewSessionKey ?? this.bridge.getCurrentSessionKey();
        if (!sessionKey || !this.bridge.canSteer()) return;
        const text = this.pendingFollowUp[targetIndex];
        const messageId = this.pendingFollowUpMessageIds[targetIndex];
        let success = false;
        try {
            success = await this.bridge.injectMessage(sessionKey, text);
        } catch (err) {
            Logger.getInstance().warn('steer queued follow-up failed', err);
        }
        if (!success) {
            this.postToWebview({ type: 'steerFailed', messageId });
            return;
        }
        this.pendingFollowUp.splice(targetIndex, 1);
        this.pendingFollowUpMessageIds.splice(targetIndex, 1);
        this.pendingFollowUpGroupWithPrevious.splice(targetIndex, 1);
        if (this.pendingFollowUpGroupWithPrevious.length > 0) {
            this.pendingFollowUpGroupWithPrevious[0] = false;
        }
        const turn = this.transcript.find((item) => item.messageId === messageId);
        if (turn) turn.isSteer = true;
        this.postToWebview({ type: 'queuedUserSteered', messageId });
        this.persistCurrentTranscript();
        this.pushFollowUpQueue();
    }

    protected handleRemoveQueuedFollowUp(index: number): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.pendingFollowUp.length) return;
        const messageId = this.pendingFollowUpMessageIds[index];
        this.pendingFollowUp.splice(index, 1);
        this.pendingFollowUpMessageIds.splice(index, 1);
        this.pendingFollowUpGroupWithPrevious.splice(index, 1);
        if (this.pendingFollowUpGroupWithPrevious.length > 0) {
            this.pendingFollowUpGroupWithPrevious[0] = false;
        }
        this.transcript = this.transcript.filter((item) => item.messageId !== messageId);
        this.postToWebview({ type: 'queuedUserRemoved', messageId });
        this.persistCurrentTranscript();
        this.pushFollowUpQueue();
    }

    protected handleSetDebugQueueStall(stall: boolean): void {
        this.debugQueueStall = stall;
        this.sendDebugQueueStallState();
    }

    protected async handleRequestEnvironmentChoices(): Promise<void> {
        const items = await this.bridgeRegistry.listEnvironmentChoices();
        this.postToWebview({ type: 'environmentChoices', items });
    }

    protected async handleSelectEnvironmentChoice(data: any): Promise<void> {
        await this.bridgeRegistry.selectEnvironmentChoice(data);
        this.currentAgentId = String(data.agentId ?? '') || undefined;
        this.pushEnvLabel();
        await this.refreshModelDisplayFromChoices();
        await this.pushSessions();
    }

    protected async handleRequestAgentChoices(): Promise<void> {
        const envItems = await this.bridge.listEnvironmentChoices().catch(() => []);
        const agents: ChoiceMenuItem[] = [];
        const visit = (items: ChoiceMenuItem[]) => {
            for (const item of items) {
                if (String(item.id).includes(':agent:') || item.agentId) {
                    agents.push({ ...item, children: undefined });
                }
                if (Array.isArray(item.children)) visit(item.children);
            }
        };
        visit(envItems);
        this.postToWebview({ type: 'agentChoices', items: agents });
    }

    protected pushSandboxDisplay(): void {
        const bridgeId = this.bridgeRegistry.active.id;
        const { sandbox, approval } = this.configManager.readSandboxSelection(bridgeId);
        this.postToWebview({
            type: 'sandboxDisplay',
            label: `${sandbox}/${approval}`,
            sandbox,
            approval,
            description: this.configManager.sandboxDisplayDescription(bridgeId),
            hidden: this.bridgeRegistry.active.capabilities.sandboxControls === false,
        });
    }

    protected async handleRequestSandboxChoices(): Promise<void> {
        const items = this.configManager.buildSandboxChoices(this.bridgeRegistry.active.id);
        this.postToWebview({ type: 'sandboxChoices', items });
    }

    protected async handleSelectSandboxChoice(data: any): Promise<void> {
        const bridgeId = this.bridgeRegistry.active.id;
        if (typeof data.sandboxMode === 'string') {
            await this.configManager.updateSandboxMode(data.sandboxMode, bridgeId);
        }
        if (typeof data.approvalMode === 'string') {
            await this.configManager.updateApprovalMode(data.approvalMode, bridgeId);
        }
        const applySandboxSelection = (this.bridge as any).applySandboxSelection;
        if (typeof applySandboxSelection === 'function') await applySandboxSelection.call(this.bridge, data);
        this.pushSandboxDisplay();
    }

    protected async handleRequestModelChoices(): Promise<void> {
        try {
            const items = this.bridge.capabilities.models
                ? await this.bridge.listModelChoices(this.currentModelId, this.currentThinking)
                : await this.loadModelChoicesViaSlash();
            this.postToWebview({ type: 'modelChoices', items });
        } catch (err) {
            Logger.getInstance().warn('model choices failed', err);
            this.postToWebview({
                type: 'modelChoices',
                items: [{
                    id: 'models-error',
                    label: t('Models unavailable'),
                    description: t('Gateway did not return model choices'),
                    disabled: true,
                    icon: 'warning',
                }],
            });
        }
    }

    protected async handleSelectModelChoice(data: any): Promise<void> {
        const selected = await this.bridge.selectModelChoice(data, this.bridge.getCurrentSessionKey());
        if (!selected) return;
        this.currentModelId = selected.modelId;
        this.currentModelDisplay = selected.display;
        this.currentThinking = selected.thinking;
        this.persistModelSelection();
        this.pushModelDisplay();
    }

    protected async loadModelChoicesViaSlash(): Promise<ChoiceMenuItem[]> {
        const text = await this.runSlashCapture('/models', 8000);
        return this.parseModelsFromText(text).map((id) => {
            const slash = id.indexOf('/');
            const provider = slash > 0 ? id.slice(0, slash) : '';
            const model = slash > 0 ? id.slice(slash + 1) : id;
            return {
                id,
                label: model,
                description: provider || undefined,
                provider,
                model,
                icon: 'symbol-method',
                checked: id === this.currentModelId || model === this.currentModelId,
                supportsReasoning: false,
            };
        });
    }

    protected pushEnvLabel(): void {
        const agentName = this.bridge.getEnvironmentLabel();
        const bridgeName = this.bridgeRegistry.active.label || this.bridgeRegistry.active.id;
        const label = agentName.includes('@') ? agentName : `${agentName}@${bridgeName}`;
        this.postToWebview({ type: 'envLabel', label });
    }

    // ── message actions (Part B/C) ─────────────────────────────────────────────

    protected async handleForkConversation(messageId?: string): Promise<void> {
        this.postToWebview({ type: 'forkStarted' });

        const targetIndex = messageId
            ? this.transcript.findIndex((turn) => turn.messageId === messageId)
            : -1;
        const sourceTurns = targetIndex >= 0 ? this.transcript.slice(0, targetIndex + 1) : this.transcript;
        const context = sourceTurns
            .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
            .join('\n\n');

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const parentKey = this.bridge.getCurrentSessionKey();
        const structuralFork = !messageId && parentKey && typeof this.bridge.forkChat === 'function'
            ? await this.bridge.forkChat(parentKey, folderUri).catch((err) => {
                Logger.getInstance().warn('structural fork failed; falling back to transcript fork', err);
                return null;
            })
            : null;
        const key = structuralFork || await this.bridge.createChat(folderUri);
        if (folderUri) this.bridge.setActiveSession(folderUri, key);
        this.rememberSessionWorkspace(key, folderUri);

        if (!structuralFork && context) {
            await this.bridge.injectMessage(key, '[Forked conversation context]\n' + context).catch(() => false);
        }
        if (folderUri) await this.ensureHiddenWorkspaceContext(key, await this.gatherContext()).catch(() => false);

        this.persistCurrentTranscript();
        this.pendingNewChat = false;
        this.adoptViewSession(key);
        this.cachedHistory = [];
        this.transcript = [];
        this.runTurnIds.clear();
        this.activeRuns.clear();
        this.completedRunIds.clear();
        this.activeRunId = null;

        try {
            const history = await this.bridge.getSessionHistory(200);
            const messages = Array.isArray(history?.messages) ? history.messages : history?.payload?.messages;
            if (Array.isArray(messages) && messages.length > 0) {
                const turns = this.historyManager.rebuildTurnsFromGatewayHistory(messages);
                this.transcript = turns;
                this.cachedHistory = turns.map((turn) => ({ role: turn.role, content: turn.content, isSteer: turn.isSteer }));
            }
        } catch (error: any) {
            Logger.getInstance().warn('restoreHistory during fork failed', error);
        }

        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: this.historyMessages(), ...this.renderBridgeConfig() });
        this.postToWebview({ type: 'updateTitle', key, title: this.defaultChatTitle() });
        vscode.window.showInformationMessage(structuralFork ? 'Conversation forked.' : 'Conversation forked with local transcript context.');
    }

    protected async handleForkAndRewind(messageId?: string): Promise<void> {
        await this.handleForkConversation(messageId);
    }

    protected async handleRewindToMessage(messageId?: string): Promise<void> {
        Logger.getInstance().info('Code rewind is temporarily disabled', { messageId });
    }

    protected async handleReviewCheckpointDiff(messageId?: string, files?: string[]): Promise<void> {
        await this.checkpoints.reviewDiff(messageId, files);
    }

    protected async handleOpenFile(filePath: string): Promise<void> {
        if (!filePath) return;
        try {
            let line: number | undefined;
            let col: number | undefined;
            const parts = filePath.split(':');
            let cleanPath = filePath;
            if (parts.length > 1) {
                const last = parts[parts.length - 1];
                const prev = parts[parts.length - 2];
                if (/^\d+$/.test(last)) {
                    if (prev && /^\d+$/.test(prev)) {
                        col = parseInt(last, 10);
                        line = parseInt(prev, 10);
                        cleanPath = parts.slice(0, -2).join(':');
                    } else {
                        line = parseInt(last, 10);
                        cleanPath = parts.slice(0, -1).join(':');
                    }
                }
            }

            if (cleanPath.startsWith('~/')) {
                const home = process.env.HOME || process.env.USERPROFILE || '';
                cleanPath = cleanPath.replace(/^~\//, home + '/');
            }

            const workspace = vscode.workspace.workspaceFolders?.[0];
            let uri: vscode.Uri;
            if (cleanPath.startsWith('/') || cleanPath.startsWith('file:')) {
                uri = vscode.Uri.file(cleanPath);
            } else if (workspace) {
                uri = vscode.Uri.joinPath(workspace.uri, cleanPath);
            } else {
                uri = vscode.Uri.file(cleanPath);
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            if (line !== undefined) {
                const zeroIndexedLine = Math.max(0, line - 1);
                const zeroIndexedCol = (col !== undefined) ? Math.max(0, col - 1) : 0;
                const position = new vscode.Position(zeroIndexedLine, zeroIndexedCol);
                const selection = new vscode.Selection(position, position);
                editor.selection = selection;
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
        } catch (err: any) {
            vscode.window.showWarningMessage(`Could not open ${filePath}: ${err.message || err}`);
        }
    }

    protected async handleSetReaction(messageId: string, value: 'up' | 'down' | null): Promise<void> {
        if (!messageId || !this.supportsMessageReactions()) return;
        const turn = this.transcript.find((item) => item.messageId === messageId || item.id === messageId);
        if (!turn || turn.role !== 'assistant') return;
        const previousReaction = turn.reaction ?? null;
        const target: BridgeMessageReactionTarget = {
            ...(turn.reactionTarget ?? {}),
            sessionKey: turn.reactionTarget?.sessionKey ?? this.bridge.getCurrentSessionKey() ?? this.viewSessionKey ?? undefined,
            messageId: turn.messageId ?? turn.id,
            previousReaction,
        };
        if (typeof this.bridge.setMessageReaction !== 'function') return;
        try {
            await this.bridge.setMessageReaction(target, value);
            turn.reaction = value;
            this.persistCurrentTranscript();
        } catch (err: any) {
            turn.reaction = previousReaction;
            this.renderTranscript();
            const message = normalizeBridgeError(err).message || String(err?.message ?? err);
            Logger.getInstance().warn('setMessageReaction failed', { bridgeId: this.bridgeRegistry.active.id, message });
            vscode.window.showWarningMessage(message);
        }
    }

    /** Push current context-window usage to the meter, when the bridge reports it. */
    protected async refreshContextUsage(): Promise<void> {
        const bridge = this.bridge;
        if (typeof bridge.getContextUsage !== 'function') return;
        const sessionKey = bridge.getCurrentSessionKey();
        if (!sessionKey) return;
        try {
            const usage = await bridge.getContextUsage(sessionKey);
            if (!usage) return;
            this.postToWebview({
                type: 'contextUsage',
                percentUsed: usage.percentUsed,
                usedTokens: usage.usedTokens,
                contextWindow: usage.contextWindow,
                canCompact: typeof bridge.compactContext === 'function',
            });
        } catch (err) { Logger.getInstance().warn('refreshContextUsage failed', err); }
    }

    /** Manually compact the active session's context, from the meter affordance. */
    protected async handleCompactContext(): Promise<void> {
        const bridge = this.bridge;
        if (typeof bridge.compactContext !== 'function') return;
        const sessionKey = bridge.getCurrentSessionKey();
        if (!sessionKey) return;
        this.postToWebview({ type: 'contextCompacting' });
        try {
            await bridge.compactContext(sessionKey);
        } catch (err) {
            Logger.getInstance().warn('compactContext failed', err);
        } finally {
            await this.refreshContextUsage();
        }
    }

    /** Resolve a blocking approval prompt from the inline webview card. */
    protected async handleApprovalRespond(data: any): Promise<void> {
        const bridge = this.bridge;
        if (typeof bridge.respondApproval !== 'function') return;
        await bridge.respondApproval({
            requestId: data?.requestId ? String(data.requestId) : undefined,
            choice: String(data?.choice || 'deny'),
            all: !!data?.all,
        });
    }

    /** Resolve a blocking input prompt (secret / sudo / clarify / terminal-read). */
    protected async handleInputRespond(data: any): Promise<void> {
        const bridge = this.bridge;
        if (typeof bridge.respondInput !== 'function') return;
        if (!data?.requestId) return;
        await bridge.respondInput({
            requestId: String(data.requestId),
            kind: String(data?.kind || ''),
            value: String(data?.value ?? ''),
        });
    }

    protected runSlashCapture(command: string, timeoutMs: number): Promise<string> {
        return new Promise<string>((resolve) => {
            let buf = '';
            let done = false;
            const onStream = (event: any) => {
                if (event.type === 'agent_message') buf = event.text || buf;
                else if (event.type === 'chat_message' && event.role === 'assistant') buf = event.content || buf;
                else if (event.type === 'agent_lifecycle' && this.isTerminalLifecyclePhase(event.phase)) finish();
            };
            const finish = () => {
                if (done) return;
                done = true;
                this.bridge.off('stream', onStream);
                resolve(buf);
            };
            this.bridge.on('stream', onStream);
            setTimeout(finish, timeoutMs);
            this.gatherContext()
                .then((ctx) => typeof this.bridge.executeSlashCommand === 'function'
                    ? this.bridge.executeSlashCommand(command, ctx)
                    : this.bridge.sendChatMessage(command, ctx))
                .catch(() => finish());
        });
    }

    protected parseModelsFromText(text: string): string[] {
        const out = new Set<string>();
        for (const line of (text || '').split(/\r?\n/)) {
            const m = line.match(/([a-z0-9][\w.\-]*\/[\w.\-:]+)/i);
            if (m) { out.add(m[1]); continue; }
            const bare = line.match(/\b([a-z][\w.\-]{2,}(?:-[\w.]+)+)\b/i);
            if (bare) out.add(bare[1]);
        }
        return [...out];
    }

    protected pushModelDisplay(): void {
        const model = this.currentModelDisplay || this.currentModelId || '';
        this.postToWebview({ type: 'modelDisplay', model, reasoning: this.currentThinking });
    }

    protected modelSelectionStorageKey(): string {
        return `junction.${this.bridgeRegistry.active.id}.modelSelection`;
    }

    protected hydrateModelSelection(): void {
        const nativeSelection = this.bridge.getSelection?.();
        const savedSelection = this.bridgeRegistry.context.workspaceState.get<BridgeSelectionState>(this.modelSelectionStorageKey(), {});
        const selection = {
            ...(savedSelection || {}),
            ...(nativeSelection || {}),
        };
        const modelId = String(selection.modelId || '').trim();
        const thinking = selection.thinking ? String(selection.thinking) : undefined;
        if (!modelId && !thinking) return;
        this.currentModelId = modelId || this.currentModelId;
        this.currentThinking = thinking;
        this.bridge.setSelection({ ...(modelId ? { modelId } : {}), ...(thinking ? { thinking } : {}) });
    }

    protected persistModelSelection(): void {
        this.bridgeRegistry.context.workspaceState.update(this.modelSelectionStorageKey(), {
            ...(this.currentModelId ? { modelId: this.currentModelId } : {}),
            ...(this.currentThinking ? { thinking: this.currentThinking } : {}),
        });
    }

    protected async refreshModelDisplayFromChoices(): Promise<void> {
        if (!this.bridge.capabilities.models) {
            this.currentModelDisplay = '';
            this.currentModelId = undefined;
            this.currentThinking = undefined;
            this.pushModelDisplay();
            return;
        }
        try {
            const choices = await this.bridge.listModelChoices(this.currentModelId, this.currentThinking);
            let selectedModelItem: ChoiceMenuItem | undefined;
            let selectedThinkingItem: ChoiceMenuItem | undefined;
            const visit = (items: ChoiceMenuItem[]) => {
                for (const item of items) {
                    const matchesCurrentModel = !!this.currentModelId
                        && (item.id === this.currentModelId || item.model === this.currentModelId || (item.provider && item.model && `${item.provider}/${item.model}` === this.currentModelId));
                    const isThinking = item.thinking !== undefined;
                    const isModelLeaf = !!item.model || item.supportsReasoning !== undefined;
                    if (isThinking && item.checked) {
                        selectedThinkingItem = item;
                    } else if (isModelLeaf && (item.checked || matchesCurrentModel)) {
                        selectedModelItem = item;
                    }
                    if (Array.isArray(item.children)) visit(item.children);
                }
            };
            visit(choices);
            const modelItem = selectedModelItem;
            if (modelItem) {
                const label = String(modelItem.label || modelItem.model || modelItem.id || '').trim();
                if (label) this.currentModelDisplay = label;
                const provider = String(modelItem.provider || '').trim();
                const model = String(modelItem.model || modelItem.id || '').trim();
                this.currentModelId = provider && model && !model.startsWith(`${provider}/`)
                    ? `${provider}/${model}`
                    : (model || this.currentModelId);
                if (modelItem.supportsReasoning === false) this.currentThinking = undefined;
            }
            if (selectedThinkingItem?.thinking !== undefined) {
                this.currentThinking = String(selectedThinkingItem.thinking);
            }
        } catch (err) {
            Logger.getInstance().warn('refresh model display failed', err);
        }
        this.pushModelDisplay();
    }

    protected async handleAttachFile(): Promise<void> {
        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uris = await vscode.window.showOpenDialog({
            title: t('Attach file to agent thread'),
            defaultUri,
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
        });
        if (!uris?.length) return;

        for (const uri of uris) {
            if (uri.scheme !== 'file') continue;
            const filePath = this.relativePathFor(uri);
            this.addAttachedPill({
                filePath,
                displayText: filePath.split('/').pop() || filePath,
                isLive: false,
            });
        }
    }

    protected handleAttachPastedFile(data: any): void {
        const name = String(data?.name || 'pasted-file');
        const content = String(data?.content || '');
        const encoding = String(data?.encoding || 'text');
        if (!content) return;

        const storageDir = this.bridgeRegistry.context.globalStorageUri.fsPath;
        const pastedDir = `${storageDir}/pasted`;
        try { fs.mkdirSync(pastedDir, { recursive: true }); } catch {}

        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const ts = Date.now();
        const filePath = `${pastedDir}/${ts}_${safeName}`;

        if (encoding === 'base64') {
            const buf = Buffer.from(content, 'base64');
            fs.writeFileSync(filePath, buf);
        } else {
            fs.writeFileSync(filePath, content, 'utf8');
        }

        this.addAttachedPill({
            filePath,
            displayText: name,
            isLive: false,
        });
    }

    protected async handleNewChat(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { vscode.window.showWarningMessage('No workspace folder open'); return; }
        this.persistCurrentTranscript();
        this.pendingNewChat = true;
        this.adoptViewSession(null);
        this.cachedHistory = [];
        this.transcript = [];
        this.runTurnIds.clear();
        this.activeRuns.clear();
        this.completedRunIds.clear();
        this.activeRunId = null;
        this.clearFollowUpQueue();
        this.postToWebview({ type: 'history', messages: [], ...this.renderBridgeConfig() });
    }

    protected async handleStopRun(): Promise<void> {
        const sessionKey = this.viewSessionKey ?? this.bridge.getCurrentSessionKey();
        if (!sessionKey) return;
        const runId = this.activeRunId ?? this.activeRunIdsBySession.get(sessionKey) ?? undefined;
        try {
            Logger.getInstance().captureDebugStream('chat-stop', {
                bridgeId: this.bridgeRegistry.active.id,
                sessionKey,
                runId: runId ?? null,
                activeRunId: this.activeRunId,
            });
            await this.bridge.stopRun(sessionKey, runId);
        } catch (err) { Logger.getInstance().error('Stop run failed', err); }
        finally {
            if (runId) this.finalizeRun(runId);
            else {
                this.activeRunIdsBySession.delete(sessionKey);
                this.activeRunId = null;
                this.postToWebview({ type: 'runActive', active: false, sessionKey });
                this.postToWebview({ type: 'runComplete' });
            }
        }
    }

    protected async handleGetUsage(): Promise<void> {
        if (!this.bridge.capabilities.usage) {
            vscode.window.showInformationMessage(`${this.bridge.label} does not report session usage.`);
            return;
        }
        const sessionKey = this.bridge.getCurrentSessionKey();
        if (!sessionKey) return;
        try {
            const u: any = await this.bridge.getUsage(sessionKey);
            this.postToWebview({ type: 'sessionUsage', usage: u });
            void this.refreshContextUsage();
            const total = (u?.inputTokens || 0) + (u?.outputTokens || 0);
            const cost = u?.cost !== undefined ? `  ·  $${u.cost}` : '';
            vscode.window.showInformationMessage(`Session usage: ${total.toLocaleString()} tokens${cost}`);
        } catch (err) { Logger.getInstance().warn('sessions.usage failed', err); }
    }

    protected async handleSlashComplete(prefix: string): Promise<void> {
        const suggestions = await this.bridge.getSlashSuggestions(prefix);
        this.postToWebview({ type: 'slashSuggestions', suggestions });
    }

    public addEditorSelectionPill(): void {
        const pill = this.createEditorPill(false);
        if (!pill) {
            vscode.window.showWarningMessage('No file-backed editor is active.');
            return;
        }
        this.addAttachedPill(pill);
    }

    public addFilePill(uri?: vscode.Uri): void {
        const target = uri ?? this.resolveCurrentFileEditor()?.document.uri;
        if (!target || target.scheme !== 'file') {
            vscode.window.showWarningMessage('No file selected for agent thread context.');
            return;
        }
        const filePath = this.relativePathFor(target);
        this.addAttachedPill({
            filePath,
            displayText: filePath.split('/').pop() || filePath,
            isLive: false,
        });
    }

    public updateLiveSelectionPill(data: SelectionData | null): void {
        if (!this.livePillPath) return;
        if (!data?.filePath) {
            this.handleToggleLivePill(false);
            return;
        }
        const uri = vscode.Uri.file(data.filePath);
        const filePath = this.relativePathFor(uri);
        const startLine = data.startLine + 1;
        const endLine = data.endLine + 1;
        const displayText = data.isEmpty
            ? `${filePath}:${startLine}`
            : `${filePath}:${startLine}${endLine !== startLine ? '-' + endLine : ''}`;
        if (this.livePillPath && this.livePillPath !== filePath) {
            this.attachedPills.delete(this.livePillPath);
        }
        this.addAttachedPill({
            filePath,
            displayText,
            isLive: true,
            startLine,
            endLine,
            selectedText: data.selectedText,
        });
    }

    protected handleAddPill(data: any): void {
        const filePath = String(data.filePath ?? '').trim();
        if (!filePath) return;
        this.addAttachedPill({
            filePath,
            displayText: String(data.displayText ?? filePath),
            isLive: !!data.isLive,
        });
    }

    protected handleRemovePill(filePath?: string): void {
        if (!filePath) return;
        this.attachedPills.delete(filePath);
        if (this.livePillPath === filePath) this.livePillPath = null;
    }

    protected handleToggleLivePill(enabled: boolean): void {
        if (!enabled) {
            if (this.livePillPath) this.attachedPills.delete(this.livePillPath);
            this.livePillPath = null;
            this.postToWebview({ type: 'updateLivePill', enabled: false });
            return;
        }

        const pill = this.createEditorPill(true);
        if (!pill) {
            vscode.window.showWarningMessage('No file-backed editor is active.');
            return;
        }
        if (this.livePillPath && this.livePillPath !== pill.filePath) {
            this.attachedPills.delete(this.livePillPath);
        }
        this.addAttachedPill(pill);
    }

    protected async handleListWorkspaceFiles(prefix?: string): Promise<void> {
        const query = String(prefix ?? '').toLowerCase();
        try {
            const uris = await vscode.workspace.findFiles(
                '**/*',
                '**/{.git,node_modules,dist,out,.vscode-test}/**',
                250
            );
            const files = uris
                .map((uri) => this.relativePathFor(uri))
                .filter((filePath) => !query || filePath.toLowerCase().includes(query))
                .sort((a, b) => a.localeCompare(b))
                .slice(0, 50)
                .map((filePath) => ({
                    path: filePath,
                    name: filePath.split('/').pop() || filePath,
                    isDirectory: false,
                }));
            this.postToWebview({ type: 'workspaceFiles', files });
        } catch (err) {
            Logger.getInstance().warn('listWorkspaceFiles failed', err);
            this.postToWebview({ type: 'workspaceFiles', files: [] });
        }
    }

    /** Add a staged pill from external commands (sendFilePath, WorkspaceTracker). */
    public addStagedPill(pill: AttachedPill): void {
        this.addAttachedPill(pill);
    }

    /** Stage file context from WorkspaceTracker auto-send as a visible pill. */
    public addStagedFileContext(fileContext: string): void {
        const match = /^Current file:\s*(.+)$/m.exec(fileContext);
        if (!match) return;
        const absolutePath = match[1].trim();
        const workspace = vscode.workspace.workspaceFolders?.[0];
        const filePath = workspace
            ? path.relative(workspace.uri.fsPath, absolutePath)
            : absolutePath;

        // Extract selection info from the context string
        const selMatch = /Selected code:\n```(\S+)\n([\s\S]*?)```/.exec(fileContext);
        const language = selMatch?.[1];
        const selectedText = selMatch?.[2]?.trim();

        // Try to get line numbers from the active editor
        let startLine: number | undefined;
        let endLine: number | undefined;
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName === absolutePath && !editor.selection.isEmpty) {
            startLine = editor.selection.start.line + 1;
            endLine = editor.selection.end.line + 1;
        }

        const displayText = selectedText && startLine
            ? `${filePath}:${startLine}${endLine && endLine !== startLine ? '-' + endLine : ''}`
            : filePath;

        this.addAttachedPill({
            filePath,
            displayText,
            isLive: false,
            startLine,
            endLine,
            language,
            selectedText,
        });
    }

    protected addAttachedPill(pill: AttachedPill): void {
        this.attachedPills.set(pill.filePath, pill);
        if (pill.isLive) this.livePillPath = pill.filePath;
        this.postToWebview({
            type: pill.isLive ? 'updateLivePill' : 'addPill',
            ...pill,
            enabled: pill.isLive ? true : undefined,
        });
    }

    protected pushAttachedPills(): void {
        for (const pill of this.attachedPills.values()) {
            this.postToWebview({
                type: pill.isLive ? 'updateLivePill' : 'addPill',
                ...pill,
                enabled: pill.isLive ? true : undefined,
            });
        }
    }

    protected buildAttachedFileContext(): string {
        if (this.attachedPills.size === 0) return '';

        const sections: string[] = [];
        for (const pill of this.attachedPills.values()) {
            const body = pill.selectedText ?? this.readAttachedFile(pill.filePath);
            if (!body) continue;
            const lineInfo = pill.startLine
                ? `\nLines: ${pill.startLine}${pill.endLine && pill.endLine !== pill.startLine ? '-' + pill.endLine : ''}`
                : '';
            sections.push(`File: ${pill.filePath}${lineInfo}\n${body}`);
        }
        return sections.length ? '[Attached Context]\n\n' + sections.join('\n\n---\n\n') : '';
    }

    protected buildOutboundFileContext(): {
        fileContext: string;
        attachedFileContext: string;
    } {
        const attachedFileContext = this.buildAttachedFileContext();
        return {
            fileContext: attachedFileContext,
            attachedFileContext,
        };
    }

    protected normalizeWorkspacePath(filePath: string): string {
        return path.normalize(this.resolveWorkspaceFilePath(filePath)).replace(/\\/g, '/');
    }

    protected refreshLivePillFromEditor(): void {
        if (!this.livePillPath) return;
        const pill = this.createEditorPill(true);
        if (!pill) return;
        if (pill.filePath !== this.livePillPath) {
            this.attachedPills.delete(this.livePillPath);
        }
        this.addAttachedPill(pill);
    }

    protected resolveCurrentFileEditor(): vscode.TextEditor | null {
        const active = vscode.window.activeTextEditor;
        if (active?.document.uri.scheme === 'file') return active;

        const current = getCurrentSelection();
        if (current?.filePath) {
            const tracked = vscode.window.visibleTextEditors.find((editor) => editor.document.fileName === current.filePath);
            if (tracked?.document.uri.scheme === 'file') return tracked;
        }

        const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file');
        return visible ?? null;
    }

    protected createEditorPill(isLive: boolean): AttachedPill | null {
        const editor = this.resolveCurrentFileEditor();
        if (!editor || editor.document.uri.scheme !== 'file') return null;
        const filePath = this.relativePathFor(editor.document.uri);
        const selection = editor.selection;
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const selectedText = selection.isEmpty ? undefined : editor.document.getText(selection);
        const suffix = selection.isEmpty
            ? `:${startLine}`
            : `:${startLine}${endLine !== startLine ? '-' + endLine : ''}`;
        return {
            filePath,
            displayText: `${filePath}${suffix}`,
            isLive,
            startLine,
            endLine,
            language: editor.document.languageId,
            selectedText,
        };
    }

    protected readAttachedFile(filePath: string): string {
        try {
            const absolutePath = this.resolveWorkspaceFilePath(filePath);
            const raw = fs.readFileSync(absolutePath, 'utf8');
            if (raw.includes('\u0000')) return '[binary file omitted]';
            const maxChars = 60000;
            return raw.length > maxChars
                ? raw.slice(0, maxChars) + `\n[truncated ${raw.length - maxChars} chars]`
                : raw;
        } catch (err) {
            Logger.getInstance().warn(`Could not read attached file: ${filePath}`, err);
            return `[could not read ${filePath}]`;
        }
    }

    protected resolveWorkspaceFilePath(filePath: string): string {
        if (filePath.startsWith('/')) return filePath;
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) return filePath;
        return vscode.Uri.joinPath(workspace.uri, ...filePath.split('/')).fsPath;
    }

    protected relativePathFor(uri: vscode.Uri): string {
        return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    }

    protected routePrefixedMessage(text: string): string {
        if (text.startsWith('!')) {
            return [
                'Treat this as a shell-command intent. Use active bridge tools and approval policy; do not execute locally from the VS Code extension.',
                text.slice(1).trim(),
            ].join('\n\n');
        }
        if (text.startsWith('#')) {
            return [
                'Treat this as a memory/context intent. Use supported memory or note-taking tools if available; otherwise answer with the needed context action.',
                text.slice(1).trim(),
            ].join('\n\n');
        }
        return text;
    }

    protected async handleUserMessage(text: string, dispatchOverride?: string): Promise<void> {
        text = this.routePrefixedMessage(text);
        const parsedSlash = parseSlashCommand(text);
        if (parsedSlash) {
            if (this.isLocalStopSlash(parsedSlash)) {
                await this.handleStopRun();
                return;
            }
            await this.dispatchSlashCommand(text);
            return;
        }
        const messageId = this.makeMessageId('m');

        let isSteer = false;
        if (this.activeRunId && (!this.pendingNewChat || this.viewSessionKey)) {
            this.refreshFollowUpMode();
            const mode = (dispatchOverride === 'queue' || dispatchOverride === 'steer' || dispatchOverride === 'interrupt')
                ? dispatchOverride
                : this.followUpMode;
            if (mode === 'steer' && this.bridge.canSteer()) {
                isSteer = true;
            }
        }

        this.appendUserTurn(text, messageId, isSteer);
        const checkpointed = await this.snapshotCheckpoint(messageId, text);
        this.markCheckpoint(messageId, checkpointed);

        if (this.activeRunId) {
            this.refreshFollowUpMode();
            const savedMode = this.followUpMode;
            // Debug stall: force queue mode regardless of config
            if (this.debugQueueStall) {
                this.followUpMode = 'queue';
            } else if (dispatchOverride === 'queue' || dispatchOverride === 'steer' || dispatchOverride === 'interrupt') {
                this.followUpMode = dispatchOverride;
            }
            const sessionKey = this.bridge.getCurrentSessionKey();
            if (this.followUpMode === 'steer' && sessionKey && this.bridge.canSteer()) {
                let success = false;
                try {
                    success = await this.bridge.injectMessage(sessionKey, text);
                } catch (err) {
                    Logger.getInstance().warn('steer (chat.inject) failed', err);
                }
                if (success) {
                    this.followUpMode = savedMode;
                    return;
                } else {
                    Logger.getInstance().warn('steer failed, queueing as follow-up');
                    this.postToWebview({ type: 'steerFailed', messageId });
                }
            }
            if (this.followUpMode === 'interrupt' && sessionKey) {
                try { await this.bridge.stopRun(sessionKey, this.activeRunId); }
                catch (err) { Logger.getInstance().warn('interrupt abort failed', err); }
            } else {
                this.enqueueFollowUp(text, messageId);
                this.followUpMode = savedMode;
                return;
            }
            this.followUpMode = savedMode;
        }

        await this.dispatchUserMessage(text);
    }

    protected async dispatchSlashCommand(text: string): Promise<void> {
        const bridge = this.bridge;
        if (typeof bridge.executeSlashCommand !== 'function') {
            await this.dispatchUserMessage(text);
            return;
        }
        try {
            this.postToWebview({ type: 'runActive', active: true });
            const dispatchContext = await this.gatherContext();
            if (this.pendingNewChat) {
                const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                const key = await bridge.createChat(folderUri);
                if (folderUri) bridge.setActiveSession(folderUri, key);
                this.rememberSessionWorkspace(key, folderUri);
                this.adoptViewSession(key);
                this.pendingNewChat = false;
            }
            if (!this.viewSessionKey) {
                const preKey = bridge.getCurrentSessionKey();
                if (preKey) this.adoptViewSession(preKey);
                else this.pendingSessionAdoption = true;
            }
            Logger.getInstance().captureDebugStream('slash-dispatch', {
                bridgeId: this.bridgeRegistry.active.id,
                sessionKey: bridge.getCurrentSessionKey(),
                command: text,
                context: dispatchContext,
            });
            captureBridgeDebug(this.bridgeRegistry.active.id, 'request', {
                operation: 'executeSlashCommand',
                sessionKey: bridge.getCurrentSessionKey(),
                command: text,
                context: dispatchContext,
            });
            await this.ensureHiddenWorkspaceContext(bridge.getCurrentSessionKey(), dispatchContext);
            await bridge.executeSlashCommand(text, dispatchContext);
            if (!this.viewSessionKey) {
                const postKey = bridge.getCurrentSessionKey();
                if (postKey) this.adoptViewSession(postKey);
            }
            this.pendingSessionAdoption = false;
            if (!this.activeRunId) this.postToWebview({ type: 'runComplete' });
        } catch (error: any) {
            Logger.getInstance().error('dispatchSlashCommand failed', error);
            const message = normalizeBridgeError(error).message;
            vscode.window.showErrorMessage('Agent bridge slash command error: ' + message);
            this.postToWebview({ type: 'response', text: t('Error: {0}', message) });
            this.postToWebview({ type: 'runComplete' });
        }
    }

    private isLocalStopSlash(command: { name: string; args: string }): boolean {
        return !command.args && (command.name === 'stop' || command.name === 'abort' || command.name === 'cancel');
    }

    protected async dispatchUserMessage(text: string): Promise<void> {
        try {
            this.postToWebview({ type: 'runActive', active: true });
            const dispatchContext = await this.gatherContext();
            if (this.pendingNewChat) {
                const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                const key = await this.bridge.createChat(folderUri);
                if (folderUri) this.bridge.setActiveSession(folderUri, key);
                this.rememberSessionWorkspace(key, folderUri);
                this.adoptViewSession(key);
                this.pendingNewChat = false;
                const autoTitle = this.deriveChatTitle(text) || this.defaultChatTitle();
                this.sessionTitles.set(key, autoTitle);
                this.postToWebview({ type: 'updateTitle', key, title: autoTitle });
                this.bridge.renameSession(key, autoTitle).catch(() => {});
            }
            const sessionKey = this.bridge.getCurrentSessionKey();
            const {
                fileContext,
                attachedFileContext,
            } = this.buildOutboundFileContext();
            // File context from attached pills is always prepended to the
            // user's message so the agent sees it as part of the same turn.
            // (The hidden workspace context injection via
            // ensureHiddenWorkspaceContext is the separate intended turn.)
            if (fileContext) {
                text = fileContext + '\n\n' + text;
            }
            const hiddenContextOk = await this.ensureHiddenWorkspaceContext(sessionKey, dispatchContext);
            const outboundText = hiddenContextOk ? text : this.withWorkspaceContext(text, dispatchContext);
            Logger.getInstance().captureDebugStream('chat-dispatch', {
                bridgeId: this.bridgeRegistry.active.id,
                sessionKey: this.bridge.getCurrentSessionKey(),
                originalText: text,
                outboundText,
                context: dispatchContext,
                fileContext,
                attachedFileContext,
            });
            captureBridgeDebug(this.bridgeRegistry.active.id, 'request', {
                operation: 'sendChatMessage',
                sessionKey: this.bridge.getCurrentSessionKey(),
                originalText: text,
                outboundText,
                context: dispatchContext,
                hasFileContext: !!fileContext,
                hasAttachedFileContext: !!attachedFileContext,
            });
            if (!this.viewSessionKey) {
                const preKey = this.bridge.getCurrentSessionKey();
                if (preKey) this.adoptViewSession(preKey);
                else this.pendingSessionAdoption = true;
            }
            await this.bridge.sendChatMessage(outboundText, dispatchContext);
            if (!this.viewSessionKey) {
                const postKey = this.bridge.getCurrentSessionKey();
                if (postKey) this.adoptViewSession(postKey);
            }
            this.pendingSessionAdoption = false;
            if (!this.bridge.canSteer() && !this.activeRunId) {
                this.postToWebview({ type: 'runComplete' });
            }
        } catch (error: any) {
            Logger.getInstance().error('dispatchUserMessage failed', error);
            const normalized = normalizeBridgeError(error);
            vscode.window.showErrorMessage('Agent bridge error: ' + normalized.message);
            this.postToWebview({ type: 'response', text: t('Error: {0}', normalized.message) });
            this.postToWebview({ type: 'runComplete' });
        }
    }

    protected async snapshotCheckpoint(messageId: string, label: string): Promise<boolean> {
        return false;
    }

    protected isDuplicateAssistantText(text: string): boolean {
        return !!this.findRecentAssistantDuplicate(text);
    }

    protected findRecentAssistantDuplicate(text: string): TranscriptTurn | null {
        const normalized = HistoryManager.normalizeAssistantText(text);
        if (!normalized) return null;
        for (let i = this.transcript.length - 1; i >= 0; i--) {
            const turn = this.transcript[i];
            if (turn.role === 'user') {
                const visible = this.visibleTurnContent('user', turn.content);
                if (visible !== null) break;
                continue;
            }
            if (turn.role !== 'assistant') continue;
            if (HistoryManager.normalizeAssistantText(turn.content) === normalized) {
                return turn;
            }
        }
        return null;
    }

    protected beginRunIfNeeded(runId: string, sessionKey?: string): void {
        if (!runId) return;
        const session = String(sessionKey ?? this.bridge.getCurrentSessionKey?.() ?? '').trim();
        const alreadyActive = this.activeRunId === runId
            && (!session || this.activeRunIdsBySession.get(session) === runId);
        if (alreadyActive) return;
        if (this.activeRunId && this.activeRunId !== runId) {
            this.finalizeRun(this.activeRunId);
        }
        this.activeRunId = runId;
        this.completedRunIds.delete(runId);
        if (session) this.activeRunIdsBySession.set(session, runId);
        this.postToWebview({ type: 'runActive', runId, active: true });
    }

    protected appendActivityNote(runId: string, text: string): void {
        const note = String(text || '').trim();
        if (!note) return;
        const turn = this.ensureAssistantTurn(runId);
        if (!turn.activityTimeline) turn.activityTimeline = [];
        const last = turn.activityTimeline[turn.activityTimeline.length - 1];
        if (last?.type === 'note' && last.text) {
            last.text += '\n\n' + note;
        } else {
            turn.activityTimeline.push({ type: 'note', text: note });
        }
        this.persistCurrentTranscript();
    }

    protected findToolTurn(runId: string, toolCallId: string): TranscriptTool | undefined {
        const turnId = this.runTurnIds.get(runId);
        const turn = turnId ? this.transcript.find((item) => item.id === turnId) : undefined;
        if (!turn?.tools?.length || !toolCallId) return undefined;
        return turn.tools.find((item) => item.toolCallId === toolCallId);
    }

    protected normalizeToolName(name: unknown): string {
        return String(name || 'tool').trim() || 'tool';
    }

    protected nextSyntheticToolCallId(runId: string): string {
        const turn = this.ensureAssistantTurn(runId);
        return `${runId}:tool:${turn.tools?.length ?? 0}`;
    }

    protected resolveToolEvent(runId: string, event: any): any {
        const explicit = String(event.toolCallId || '').trim();
        if (explicit) return event;

        const toolName = this.normalizeToolName(event.toolName);
        let pendingByName = this.pendingToolCallIds.get(runId);
        if (!pendingByName) {
            pendingByName = new Map<string, string[]>();
            this.pendingToolCallIds.set(runId, pendingByName);
        }

        if (event.phase === 'start') {
            const toolCallId = this.nextSyntheticToolCallId(runId);
            const queue = pendingByName.get(toolName) ?? [];
            queue.push(toolCallId);
            pendingByName.set(toolName, queue);
            return { ...event, toolCallId };
        }

        const queue = pendingByName.get(toolName) ?? [];
        const toolCallId = queue.shift() || this.nextSyntheticToolCallId(runId);
        if (queue.length) pendingByName.set(toolName, queue);
        else pendingByName.delete(toolName);
        return { ...event, toolCallId };
    }

    protected updateThinkingTurn(runId: string, text: string, complete = false, durationMs?: number): void {
        const turn = this.ensureAssistantTurn(runId);
        turn.thinking = text;
        turn.thinkingComplete = complete;
        if (durationMs !== undefined) turn.thinkingDurationMs = durationMs;
        this.persistCurrentTranscript();
    }

    protected hidesRawThinking(): boolean {
        return !!this.bridgeRegistry.active.capabilities.hidesRawThinking;
    }

    protected supportsMessageReactions(): boolean {
        return !!this.bridgeRegistry.active.capabilities.messageReactions
            && typeof this.bridgeRegistry.active.setMessageReaction === 'function';
    }

    protected mirrorsAssistantChatMessages(): boolean {
        return this.bridgeRegistry.active.id === 'openclaw';
    }

    protected upsertToolTurn(runId: string, event: any, formattedArgs?: string, formattedResult?: string): TranscriptTool {
        const turn = this.ensureAssistantTurn(runId);
        const toolCallId = String(event.toolCallId || `${runId}:tool:${turn.tools?.length ?? 0}`);
        if (!turn.tools) turn.tools = [];
        let tool = turn.tools.find((item) => item.toolCallId === toolCallId);
        if (!tool) {
            tool = { toolCallId };
            turn.tools.push(tool);
            if (!turn.activityTimeline) turn.activityTimeline = [];
            turn.activityTimeline.push({ type: 'tool', toolCallId });
        }
        if (event.toolName) tool.toolName = String(event.toolName);
        if (formattedArgs !== undefined) tool.args = formattedArgs;
        if (event.phase === 'update') tool.updates = (tool.updates || '') + (formattedResult || '');
        if (event.phase === 'result') {
            tool.result = formattedResult ?? '';
            tool.isError = !!event.isError;
        }
        tool.phase = event.phase || tool.phase;
        this.persistCurrentTranscript();
        return tool;
    }

    protected handleStreamEvent(event: any): void {
        Logger.getInstance().captureDebugStream('chat-stream-raw', {
            bridgeId: event?._bridgeId ?? this.bridgeRegistry.active.id,
            activeBridgeId: this.bridgeRegistry.active.id,
            viewSessionKey: this.viewSessionKey,
            activeSessionKey: this.bridge.getCurrentSessionKey?.(),
            event,
        });
        captureBridgeDebug(event?._bridgeId ?? this.bridgeRegistry.active.id, 'normalized', {
            operation: 'stream',
            sessionKey: event?.sessionKey,
            runId: event?.runId,
            eventType: event?.type,
            event,
        });
        if (event._bridgeId && event._bridgeId !== this.bridgeRegistry.active.id) return;
        const eventSession = String(event?.sessionKey ?? '').trim();
        if (!eventSession) {
            Logger.sessionDebug(this.bridgeRegistry.context, { op: 'stream.dropped.noSessionKey', eventType: event?.type, runId: event?.runId });
            return;
        }
        const currentSession = String(this.bridge.getCurrentSessionKey() ?? '').trim();
        if (!this.viewSessionKey && this.pendingSessionAdoption) {
            if (currentSession && eventSession === currentSession) {
                this.adoptViewSession(currentSession);
                this.pendingSessionAdoption = false;
            }
        }
        if (currentSession && eventSession === currentSession && this.viewSessionKey !== currentSession && String(this.viewSessionKey || '').includes('pending')) {
            this.adoptViewSession(currentSession);
            this.pendingSessionAdoption = false;
        }
        if (!this.viewSessionKey || eventSession !== this.viewSessionKey) {
            Logger.sessionDebug(this.bridgeRegistry.context, { op: 'stream.dropped.sessionMismatch', eventSession, viewSessionKey: this.viewSessionKey, eventType: event?.type });
            return;
        }

        if (event.type === 'agent_lifecycle' && event.phase === 'start') {
            this.beginRunIfNeeded(event.runId || this.resolveRunId(event, 'agent'), event.sessionKey);
        }

        if (event.type === 'thinking_chunk') {
            const runId = this.resolveRunId(event, 'thinking');
            this.beginRunIfNeeded(runId, event.sessionKey);
            if (!this.thinkingStart.has(runId)) this.thinkingStart.set(runId, Date.now());
            const prev = this.thinkingBuffers.get(runId) || '';
            const delta = event.text || '';
            const buf = prev + delta;
            this.thinkingBuffers.set(runId, buf);
            this.appendActivityNote(runId, delta);
            this.updateThinkingTurn(runId, buf);
            this.postToWebview({
                type: 'thinking_chunk',
                runId,
                text: delta,
                fullText: buf,
                sessionKey: event.sessionKey,
            });
            const hideRawThinking = this.hidesRawThinking();
            Logger.getInstance().captureDebugStream('chat-stream-filtered', {
                bridgeId: this.bridgeRegistry.active.id,
                branch: 'thinking_chunk',
                runId,
                rawEvent: event,
                hideRawThinking,
                emitted: {
                    type: 'thinking_chunk',
                    text: delta,
                    fullText: buf,
                },
            });
            return;
        }

        if (event.type === 'agent_message') {
            const runId = this.resolveRunId(event, 'agent');
            this.beginRunIfNeeded(runId, event.sessionKey);
            this.mergeReactionTarget(runId, event);
            if (this.mirrorsAssistantChatMessages()) {
                Logger.getInstance().captureDebugStream('chat-stream-filtered', {
                    bridgeId: this.bridgeRegistry.active.id,
                    branch: 'agent_message',
                    runId,
                    rawEvent: event,
                    dropped: 'mirrored-by-chat-message',
                });
                return;
            }
            const lastText = this.activeRuns.get(runId) || '';
            const nextText = this.extractVisibleAssistantText(runId, event.text || lastText);
            Logger.getInstance().captureDebugStream('chat-stream-filtered', {
                bridgeId: this.bridgeRegistry.active.id,
                branch: 'agent_message',
                runId,
                rawEvent: event,
                lastText,
                nextText,
                dropped: nextText === null ? 'hidden-before-reply-marker' : null,
            });
            if (nextText === null) return;
            const duplicate = this.findRecentAssistantDuplicate(nextText);
            if (duplicate && duplicate.runId !== runId) return;
            this.updateAssistantTurn(runId, nextText, event.commandOutput);
            return;
        }

        if (event.type === 'chat_message' && event.role === 'assistant') {
            const runId = this.resolveRunId(event, 'chat');
            this.mergeReactionTarget(runId, event);
            const lastText = this.activeRuns.get(runId) || '';
            const nextText = this.extractVisibleAssistantText(runId, event.content || lastText, event.state === 'final');
            const turnId = this.runTurnIds.get(runId);
            const turn = turnId ? this.transcript.find(t => t.id === turnId) : undefined;
            const completedDuplicate = nextText !== null
                && this.completedRunIds.has(runId)
                && HistoryManager.normalizeAssistantText(turn?.content || '') === HistoryManager.normalizeAssistantText(nextText);
            Logger.getInstance().captureDebugStream('chat-stream-filtered', {
                bridgeId: this.bridgeRegistry.active.id,
                branch: 'chat_message_assistant',
                runId,
                rawEvent: event,
                lastText,
                nextText,
                dropped: nextText === null ? 'hidden-before-reply-marker' : (completedDuplicate ? 'completed-run-duplicate' : null),
            });
            if (nextText === null) return;
            if (completedDuplicate) return;
            const duplicate = this.findRecentAssistantDuplicate(nextText);
            if (duplicate && duplicate.runId !== runId) return;
            this.updateAssistantTurn(runId, nextText);
            if (event.state === 'final') {
                const finalTurnId = this.runTurnIds.get(runId);
                const finalTurn = finalTurnId ? this.transcript.find(t => t.id === finalTurnId) : undefined;
                const messageId = finalTurn?.messageId || finalTurnId;
                this.postToWebview({ type: 'assistant_stream_end', runId, messageId });
                this.activeRuns.delete(runId);
                this.completedRunIds.add(runId);
            }
            return;
        }

        if (event.type === 'tool_event') {
            const runId = this.resolveRunId(event, 'tool');
            this.beginRunIfNeeded(runId, event.sessionKey);
            event = this.resolveToolEvent(runId, event);
            this.checkpoints.recordTouchedPathsFromValue(event.args);
            this.checkpoints.recordTouchedPathsFromValue(event.result);
            const requestedToolCallId = String(event.toolCallId || '');
            const existingTool = requestedToolCallId ? this.findToolTurn(runId, requestedToolCallId) : undefined;
            if (event.phase === 'start') {
                const args = ToolEventHandler.formatToolArgs(event.args || {});
                const tool = this.upsertToolTurn(runId, event, args);
                this.postToWebview({ type: 'tool_start', runId, toolCallId: tool.toolCallId, toolName: event.toolName, args });
            } else if (event.phase === 'update') {
                const text = ToolEventHandler.formatToolResult(event.result ?? '', false);
                const tool = this.upsertToolTurn(runId, event, undefined, text);
                if (!existingTool) {
                    const args = ToolEventHandler.formatToolArgs(event.args || {});
                    this.postToWebview({ type: 'tool_start', runId, toolCallId: tool.toolCallId, toolName: tool.toolName, args });
                }
                this.postToWebview({ type: 'tool_update', runId, toolCallId: tool.toolCallId, text });
            } else if (event.phase === 'result') {
                const result = ToolEventHandler.formatToolResult(event.result ?? '', event.isError || false);
                const tool = this.upsertToolTurn(runId, event, undefined, result);
                if (!existingTool) {
                    const args = tool.args ?? ToolEventHandler.formatToolArgs(event.args || {});
                    this.postToWebview({ type: 'tool_start', runId, toolCallId: tool.toolCallId, toolName: tool.toolName, args });
                }
                this.postToWebview({
                    type: 'tool_result',
                    runId,
                    toolCallId: tool.toolCallId,
                    toolName: tool.toolName,
                    args: tool.args,
                    result,
                    isError: event.isError || false,
                });
            }
            return;
        }

        if (event.type === 'approval_request') {
            const runId = this.resolveRunId(event, 'agent');
            this.beginRunIfNeeded(runId, event.sessionKey);
            this.postToWebview({
                type: 'approvalRequest',
                runId,
                requestId: event.requestId,
                kind: event.kind,
                toolName: event.toolName,
                command: event.command,
                description: event.description,
                paths: event.paths,
                network: event.network,
                options: event.options,
                allowPermanent: event.allowPermanent !== false,
            });
            return;
        }

        if (event.type === 'input_request') {
            const runId = this.resolveRunId(event, 'agent');
            this.beginRunIfNeeded(runId, event.sessionKey);
            this.postToWebview({
                type: 'inputRequest',
                runId,
                requestId: event.requestId,
                kind: event.kind,
                prompt: event.prompt,
                secret: !!event.secret,
            });
            return;
        }

        if (event.type === 'status') {
            this.postToWebview({ type: 'status', kind: event.kind, text: event.text });
            return;
        }

        if (event.type === 'agent_lifecycle' && this.isTerminalLifecyclePhase(event.phase)) {
            this.finalizeRun(this.resolveRunId(event, 'agent'), event.usage);
        }

        if ((event.type === 'agent' || event.type === 'chat') && (event.payload || event).sessionKey) {
            const payload = event.payload || event;
            if (payload.sessionKey.includes(':subagent:') || payload.spawnedBy) {
                this.postToWebview({
                    type: 'subagentInfo',
                    runId: event.runId,
                    sessionKey: payload.sessionKey,
                    spawnedBy: payload.spawnedBy,
                    subagentRole: payload.subagentRole,
                    spawnDepth: payload.spawnDepth,
                });
            }
        }
    }

    protected finalizeRun(runId: string, usage?: { inputTokens?: number; outputTokens?: number }): void {
        if (!runId || this.completedRunIds.has(runId)) return;
        const turnId = this.runTurnIds.get(runId);
        const turn = turnId ? this.transcript.find(t => t.id === turnId) : undefined;
        const messageId = turn?.messageId || turnId;
        this.postToWebview({ type: 'assistant_stream_end', runId, messageId });
        this.activeRuns.delete(runId);
        this.completedRunIds.add(runId);
        for (const [session, rid] of this.activeRunIdsBySession) {
            if (rid === runId) this.activeRunIdsBySession.delete(session);
        }
        if (this.activeRunId === runId || this.activeRunId === null) {
            this.activeRunId = null;
            this.postToWebview({ type: 'runActive', active: false });
        }
        const thinkingBuf = this.thinkingBuffers.get(runId);
        if (thinkingBuf !== undefined) {
            const startedAt = this.thinkingStart.get(runId);
            const durationMs = startedAt ? Date.now() - startedAt : 0;
            this.updateThinkingTurn(runId, thinkingBuf, true, durationMs);
            this.postToWebview({
                type: 'thinking_end',
                runId,
                tokenCount: thinkingBuf.length,
                durationMs,
                sessionKey: this.viewSessionKey,
            });
            this.thinkingBuffers.delete(runId);
            this.thinkingStart.delete(runId);
        }
        if (usage) {
            this.postToWebview({
                type: 'tokenUsage',
                runId,
                inputTokens: usage.inputTokens || 0,
                outputTokens: usage.outputTokens || 0,
            });
        }
        void this.refreshContextUsage();

        const queued = this.dequeueFollowUp();
        if (queued) {
            void this.dispatchUserMessage(queued);
        }
    }

    protected async gatherContext(): Promise<any> {
        const editor = vscode.window.activeTextEditor;
        const workspace = vscode.workspace.workspaceFolders?.[0];
        return {
            workspace: workspace?.uri.fsPath,
            workspaceFolder: workspace?.uri.fsPath,
            activeFile: editor?.document.fileName,
            language: editor?.document.languageId,
            selection: editor?.selection ? { start: editor.selection.start.line, end: editor.selection.end.line } : null,
        };
    }

    protected stripReplyMarker(text: string): string {
        const idx = text.indexOf('[[reply_to_current]]');
        return idx === -1 ? text : text.slice(idx + '[[reply_to_current]]'.length).trimStart();
    }

    protected extractVisibleAssistantText(runId: string, text: string, isFinal = false): string | null {
        const raw = String(text || '');
        if (!raw) return raw;
        if (raw.includes('[[reply_to_current]]')) {
            const stripped = this.stripReplyMarker(raw);
            const sanitized = HistoryManager.sanitizeAssistantDisplayText(stripped);
            return sanitized || null;
        }

        const turnId = this.runTurnIds.get(runId);
        const turn = turnId ? this.transcript.find((item) => item.id === turnId) : undefined;
        const hasThinkingStream = this.thinkingBuffers.has(runId) || !!turn?.thinking;

        if (!isFinal && this.hidesRawThinking() && hasThinkingStream) {
            return null;
        }

        const sanitized = HistoryManager.sanitizeAssistantDisplayText(raw);
        return sanitized || null;
    }

    protected async handleLoadMoreHistory(): Promise<void> {
        await this.historyManager.handleLoadMoreHistory(
            this.bridge,
            this.transcript,
            (turns, historyItems) => {
                this.transcript = turns;
                this.cachedHistory = historyItems;
            }
        );
    }

    protected async handleLoadMoreHistoryFromJsonl(offset: number = 0): Promise<void> {
        try {
            const sessionKey = this.bridge.getCurrentSessionKey();
            if (!sessionKey || !(this.bridge as any).getSessionHistoryFromJsonl) {
                await this.handleLoadMoreHistory();
                return;
            }
            const result = await (this.bridge as any).getSessionHistoryFromJsonl(sessionKey, offset, 256 * 1024);
            if (!result || !result.messages || result.messages.length === 0) {
                await this.handleLoadMoreHistory();
                return;
            }
            const turns = this.historyManager.rebuildTurnsFromGatewayHistory(result.messages);
            this.postToWebview({
                type: 'moreHistory',
                turns,
                hasMore: result.hasMore,
                nextOffset: result.nextOffset,
            });
        } catch (error: any) {
            Logger.getInstance().warn('handleLoadMoreHistoryFromJsonl failed', error);
        }
    }

    protected pushToolStatus(): void {
        const status = this.bridge.getToolStatus();
        if (status) {
            this.postToWebview({
                type: 'toolStatus',
                activeTools: status.tools.filter(t => t.enabled).map(t => t.name),
                totalTools: status.tools.length,
            });
        }
    }
}

function summarizeWebviewMessage(message: any): Record<string, unknown> {
    const messages = Array.isArray(message?.messages) ? message.messages : [];
    const turns = Array.isArray(message?.turns) ? message.turns : [];
    const rows = messages.length ? messages : turns;
    const assistantRows = rows.filter((row: any) => row?.role === 'assistant');
    const assistantBodyLength = assistantRows.reduce((n: number, row: any) => n + String(row?.content || '').length, 0);
    const thinkingLength = assistantRows.reduce((n: number, row: any) => n + String(row?.thinking || '').length, 0)
        + String(message?.thinking || '').length
        + String(message?.text && message?.type === 'thinking_chunk' ? message.text : '').length;
    const toolCount = assistantRows.reduce((n: number, row: any) => n + (Array.isArray(row?.tools) ? row.tools.length : 0), 0)
        + (message?.type && String(message.type).startsWith('tool_') ? 1 : 0);
    const activityTimelineCount = assistantRows.reduce((n: number, row: any) => n + (Array.isArray(row?.activityTimeline) ? row.activityTimeline.length : 0), 0);
    const rawText = JSON.stringify({
        content: assistantRows.map((row: any) => row?.content),
        text: message?.text,
        fullText: message?.fullText,
    });
    return {
        messageType: message?.type,
        messageCount: rows.length,
        assistantCount: assistantRows.length,
        assistantBodyLength,
        thinkingLength,
        toolCount,
        activityTimelineCount,
        interleaveTimeline: message?.interleaveTimeline,
        compactTimelineMode: message?.compactTimelineMode,
        renderMode: message?.renderMode ?? message?.viewMode ?? 'unknown',
        rawJsonLookingContent: /(^|[\s\n])[\[{]"?[A-Za-z0-9_$-]+/.test(rawText),
    };
}
