import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Logger } from '../utils/logger';
import { ToolEventHandler } from './toolEventHandler';
import { CheckpointManager } from '../checkpoints/checkpointManager';
import { BridgeRegistry } from '../bridges/registry';
import { BridgeSession, ChatBridge, ChoiceMenuItem, SessionGroup, VSCODE_WORKSPACE_CONTEXT_PREFIX, WORKSPACE_LINE_PREFIX_RE } from '../bridges/types';
import { config } from '../config/agentBridgeConfig';
import { SelectionData } from '../context/selection-tracker';

interface AttachedPill {
    filePath: string;
    displayText: string;
    isLive: boolean;
    startLine?: number;
    endLine?: number;
    language?: string;
    selectedText?: string;
}

interface TranscriptTurn {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    runId?: string;
    messageId?: string;
    hasCheckpoint?: boolean;
    thinking?: string;
    thinkingComplete?: boolean;
    thinkingDurationMs?: number;
    tools?: TranscriptTool[];
}

interface TranscriptTool {
    toolCallId: string;
    toolName?: string;
    args?: string;
    updates?: string;
    result?: string;
    isError?: boolean;
    phase?: 'start' | 'update' | 'result';
}

const LEGACY_VSCODE_WORKSPACE_CONTEXT_PREFIX = 'This session is driven from the VS Code extension.';

/**
 * Shared logic for ChatViewProvider (sidebar) and ChatPanel (editor column).
 * Subclasses implement postToWebview() to route messages to their specific
 * webview surface, and buildHtml() to get the webview URI object.
 *
 * The webview UI is the modular shell under resources/webview/ (template.html
 * + tokens.css + per-component JS/CSS modules). buildHtml() assembles it; the
 * extension side here is pure transport (stream events ↔ postMessage).
 */
export abstract class ChatBase {
    /** Unique ID for this view instance — prevents cross-window bleed. */
    protected readonly viewId = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    /** Session key this view is currently displaying — used to filter events. */
    protected viewSessionKey: string | null = null;
    /** True while a send is in flight on a view that has no session yet —
     *  lets handleStreamEvent adopt the session the bridge just created. */
    protected pendingSessionAdoption = false;

    /**
     * Single entry point for changing the displayed session: updates the
     * view filter AND the transport-level watch set (shared-gateway bridges
     * drop conversation events for unwatched sessions at the connection).
     */
    protected adoptViewSession(key: string | null): void {
        const next = key ? String(key).trim() || null : null;
        if (this.viewSessionKey === next) {
            if (next) this.bridge.watchSession?.(next);
            return;
        }
        if (this.viewSessionKey) this.bridge.unwatchSession?.(this.viewSessionKey);
        this.viewSessionKey = next;
        if (next) this.bridge.watchSession?.(next);
        // Non-chat UX is window+displayed-session state: entering a different
        // chat must show ITS run state (stop/send button, working indicator),
        // not the previous chat's.
        const running = !!(next && this.activeRunIdsBySession.get(next));
        this.activeRunId = next ? (this.activeRunIdsBySession.get(next) ?? null) : null;
        this.postToWebview({ type: 'runActive', active: running, sessionKey: next ?? undefined });
    }
    protected activeRuns = new Map<string, string>();
    protected cachedHistory: Array<{ role: string; content: string }> = [];
    protected transcript: TranscriptTurn[] = [];
    protected runTurnIds = new Map<string, string>();
    protected fallbackRunCounter = 0;
    protected activeRunId: string | null = null;
    protected currentModelDisplay: string = '';
    protected checkpoints: CheckpointManager;
    protected thinkingBuffers = new Map<string, string>();
    protected thinkingStart = new Map<string, number>();
    protected sessionTranscripts = new Map<string, TranscriptTurn[]>();
    protected currentThinking: string | undefined;
    protected currentAgentId: string | undefined;
    protected followUpMode: 'queue' | 'steer' | 'interrupt' = 'queue';
    protected pendingFollowUp: string | null = null;
    protected archivedKeys = new Set<string>();
    protected chatScope: 'folder' | 'all' = 'folder';
    protected attachedPills = new Map<string, AttachedPill>();
    protected livePillPath: string | null = null;
    protected currentModelId: string | undefined;
    protected pendingNewChat = false;

    constructor(
        protected readonly extensionUri: vscode.Uri,
        protected readonly bridgeRegistry: BridgeRegistry
    ) {
        this.checkpoints = new CheckpointManager(bridgeRegistry.context);
        this.attachBridgeStreamListener(this.bridgeRegistry.active);
        this.bridgeRegistry.on('changed', (newBridge) => {
            this.detachBridgeStreamListener();
            this.attachBridgeStreamListener(newBridge);
            this.cachedHistory = [];
            this.transcript = [];
            this.runTurnIds.clear();
            this.activeRuns.clear();
            this.activeRunId = null;
            this.currentModelDisplay = '';
            this.currentModelId = undefined;
            this.currentThinking = undefined;
            this.postToWebview({ type: 'clearChat' });
            void this.handleInitRequest();
        });
        // Safety net: if webview posted initRequest before the ready handler
        // fired, ensure we retry once after a short delay.
        setTimeout(() => {
            void this.handleInitRequest();
        }, 500);

        // Live look-and-feel: re-push config and repaint when stream-display
        // settings change so layout switches apply without a reload.
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('junction.activityStream') ||
                e.affectsConfiguration('junction.reasoningDisplay') ||
                e.affectsConfiguration('junction.sendBehavior') ||
                e.affectsConfiguration('junction.extraRichText') ||
                e.affectsConfiguration('junction.showFullHistory')) {
                this.sendConfig();
                this.renderTranscript();
            }
        });
    }

    protected get bridge() {
        return this.bridgeRegistry.active;
    }

    /** Bound stream handler reference for clean attach/detach. */
    private _streamHandler?: (event: any) => void;
    private _streamBridge?: ChatBridge;

    /** Listen to stream events from the given bridge. */
    private attachBridgeStreamListener(bridge?: ChatBridge): void {
        const target = bridge || this.bridgeRegistry.active;
        this._streamHandler = (event: any) => {
            // Tag event with bridge ID for stale-event guard
            event._bridgeId = target.id;
            // Single-session bridges (Souveraine/Hermes) emit events without a
            // sessionKey; stamp their current session so the cross-window
            // filter can match instead of dropping them.
            if (!event.sessionKey) {
                const key = target.getCurrentSessionKey?.();
                if (key) event.sessionKey = key;
            }
            this.handleStreamEvent(event);
        };
        this._streamBridge = target;
        target.on('stream', this._streamHandler);
    }

    /** Remove stream listener from the tracked bridge. */
    private detachBridgeStreamListener(): void {
        if (this._streamHandler && this._streamBridge) {
            this._streamBridge.removeListener('stream', this._streamHandler);
            this._streamHandler = undefined;
            this._streamBridge = undefined;
        }
    }

    /** Send a message to the underlying webview. Subclasses implement this. */
    protected abstract postToWebview(message: any): void;

    /**
     * Assemble the modular webview HTML from resources/webview/.
     * Reads template.html, replaces CSP/nonce/asset placeholders, links every
     * component stylesheet, and injects the JS module scripts (markdown-it +
     * component modules, central dispatcher last) before </body>.
     */
    protected buildHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview');
        const assetUri = (file: string) =>
            webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, file)).toString();
        const mdUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js')
        ).toString();

        let html: string;
        try {
            html = fs.readFileSync(vscode.Uri.joinPath(webviewDir, 'template.html').fsPath, 'utf8');
        } catch (e) {
            Logger.getInstance().error('Failed to read webview template', e);
            return '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1rem">Failed to load Junction chat UI.</body></html>';
        }

        // Component stylesheets beyond tokens/codicon (those have own placeholders).
        const cssFiles = [
            'view-router.css', 'choice-menu.css', 'chat-header.css', 'session-list.css',
            'attached-files-bar.css', 'composer.css', 'chat-stream.css',
        ];
        // Module scripts: define-globals modules first, central dispatcher
        // (view-router.js) last. markdown-it before chat-stream (which uses it).
        const jsFiles = [
            'choice-menu.js', 'chat-header.js', 'session-list.js', 'attached-files-bar.js',
            'composer.js', 'chat-stream.js', 'view-router.js',
        ];

        const cssLinks = cssFiles
            .map((f) => `  <link rel="stylesheet" href="${assetUri(f)}">`)
            .join('\n');
        const moduleScripts = [
            `  <script nonce="${nonce}" src="${mdUri}"></script>`,
            `  <script nonce="${nonce}" src="${assetUri('pretext.bundle.js')}"></script>`,
            ...jsFiles.map((f) => `  <script nonce="${nonce}" src="${assetUri(f)}"></script>`),
        ].join('\n');

        html = html
            .replace(/\$\{NONCE_PLACEHOLDER\}/g, nonce)
            .replace(/\$\{CSP_SOURCE_PLACEHOLDER\}/g, webview.cspSource)
            .replace(/\$\{TOKENS_CSS_URI\}/g, assetUri('tokens.css'))
            .replace(/\$\{CODICON_CSS_URI\}/g, assetUri('codicon.css'));

        // The template has a single ${CHAT_CSS_URI} <link>; expand it into the
        // full component stylesheet chain.
        html = html.replace(
            /[ \t]*<link rel="stylesheet" href="\$\{CHAT_CSS_URI\}">/,
            cssLinks
        );

        // Inject module scripts AFTER the template's inline <script> so composer.js
        // can clone-and-rewire the inline listeners and view-router.js can override
        // the inline nav stubs.
        html = html.replace('</body>', moduleScripts + '\n</body>');

        return html;
    }

    /** Wire up message handler for the given webview. Call from subclass after creating webview. */
    protected wireMessageHandler(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (data) => {
            try {
                switch (data.type) {
                    // boot
                    case 'ready': await this.handleInitRequest(); break;
                    case 'initRequest': await this.handleInitRequest(); break;
                    // composer
                    case 'sendMessage': await this.handleUserMessage(data.text, data.dispatchOverride); break;
                    case 'stopRun': await this.handleStopRun(); break;
                    case 'consoleError': Logger.getInstance().error('[webview]', data.text); break;
                    case 'attachFile': await this.handleAttachFile(); break;
                    case 'slashComplete': await this.handleSlashComplete(data.prefix); break;
                    // chats list / header (module vocabulary)
                    case 'createChat': await this.handleCreateChat(data.text); break;
                    case 'newChat': await this.handleCreateChat(undefined); break;
                    case 'newChatThenSend': await this.handleNewChatThenSend(data.text); break;
                    case 'resumeSession': await this.handleResumeSession(data.key); break;
                    case 'backToSessions': await this.handleViewSessionList(); break;
                    case 'viewSessionList': await this.handleViewSessionList(); break;
                    case 'renameSession': await this.handleRenameSession(data.key, data.label); break;
                    case 'archiveSession': await this.handleArchiveSession(data.key); break;
                    case 'showArchivedSessions': await this.handleShowArchived(!!data.show); break;
                    case 'setChatScope': await this.handleSetChatScope(data.scope); break;
                    // footer/header choice menus
                    case 'requestModelChoices': await this.handleRequestModelChoices(); break;
                    case 'selectModelChoice': await this.handleSelectModelChoice(data); break;
                    case 'requestReasoningChoices': await this.handleRequestReasoningChoices(); break;
                    case 'selectReasoningChoice': await this.handleSelectReasoningChoice(data); break;
                    case 'requestEnvironmentChoices': await this.handleRequestEnvironmentChoices(); break;
                    case 'selectEnvironmentChoice': await this.handleSelectEnvironmentChoice(data); break;
                    case 'selectAgentChoice': await this.handleSelectEnvironmentChoice(data); break;
                    case 'requestSandboxChoices': await this.handleRequestSandboxChoices(); break;
                    case 'selectSandboxChoice': await this.handleSelectSandboxChoice(data); break;
                    case 'selectHeaderAction': await this.handleHeaderAction(data); break;
                    // attached file/context pills
                    case 'listWorkspaceFiles': await this.handleListWorkspaceFiles(data.prefix); break;
                    case 'attachCurrentFile': this.addFilePill(); break;
                    case 'addPill': this.handleAddPill(data); break;
                    case 'removePill': this.handleRemovePill(data.filePath); break;
                    case 'toggleLivePill': this.handleToggleLivePill(!!data.enabled); break;
                    // header
                    case 'loadMoreHistory': await this.handleLoadMoreHistory(); break;
                    case 'loadMoreHistoryFromJsonl': await this.handleLoadMoreHistoryFromJsonl(data.offset); break;
                    case 'openSettings': await this.handleOpenSettings(); break;
                    case 'getUsage': await this.handleGetUsage(); break;
                    // message actions (Part B/C)
                    case 'forkConversation': await this.handleForkConversation(data.messageId); break;
                    case 'rewindCode': await this.handleRewindCode(data.messageId, !!data.fork); break;
                    case 'openFile': await this.handleOpenFile(data.filePath); break;
                    case 'copyToClipboard': await vscode.env.clipboard.writeText(data.text || ''); break;
                }
            } catch (error: any) {
                const message = error?.message || String(error);
                Logger.getInstance().error('webview message handler failed', error);
                this.postToWebview({ type: 'response', text: 'Error: ' + message });
                this.postToWebview({ type: 'runComplete' });
            }
        });
    }

    // ─── handlers ───────────────────────────────────────────────────────────

    /** Resolve the composer send-behavior mode from settings (default `enter`). */
    protected getSendBehavior(): 'enter' | 'ctrlEnter' | 'smartEnter' {
        const v = config().get<string>('sendBehavior', 'enter');
        return (v === 'ctrlEnter' || v === 'smartEnter') ? v : 'enter';
    }

    protected defaultChatTitle(): string {
        return vscode.workspace.workspaceFolders?.[0]?.name || 'Chat';
    }

    protected makeMessageId(prefix = 'm'): string {
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    }

    /** Derive a short chat title from the first user message (auto-naming). */
    protected deriveChatTitle(text: string): string {
        const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // Skip the routePrefixedMessage instruction preamble lines.
        const line = lines.find((l) => !/^Treat this as/i.test(l)) || lines[0] || '';
        const clean = line.replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        return clean.length > 48 ? clean.slice(0, 47).trimEnd() + '…' : clean;
    }

    protected visibleTurnContent(role: string, content: string): string | null {
        const text = String(content || '');
        const trimmed = text.trim();
        // Filter workspace context messages at ALL levels
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
        if (role === 'user') {
            return text.replace(WORKSPACE_LINE_PREFIX_RE, '');
        }
        return text;
    }

    protected cloneTranscript(turns: TranscriptTurn[]): TranscriptTurn[] {
        return turns.map((turn) => ({
            ...turn,
            tools: turn.tools?.map((tool) => ({ ...tool })),
        }));
    }

    protected persistCurrentTranscript(): void {
        const key = this.bridge.getCurrentSessionKey();
        if (!key || this.transcript.length === 0) return;
        this.sessionTranscripts.set(key, this.cloneTranscript(this.transcript));
    }

    protected restoreTranscriptFromCache(key: string): boolean {
        const saved = this.sessionTranscripts.get(key);
        if (!saved?.length) return false;
        this.transcript = this.cloneTranscript(saved);
        this.runTurnIds.clear();
        this.activeRuns.clear();
        for (const turn of this.transcript) {
            if (turn.runId) {
                this.runTurnIds.set(turn.runId, turn.id);
                if (turn.role === 'assistant') this.activeRuns.set(turn.runId, turn.content);
            }
        }
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

    protected historyMessages(): Array<{ role: string; content: string; messageId?: string; hasCheckpoint?: boolean }> {
        return this.transcript
            .map((turn) => {
                const content = this.visibleTurnContent(turn.role, turn.content);
                const hasDebug = !!turn.thinking || !!turn.tools?.length;
                if (content === null && !hasDebug) return null;
                return {
                    role: turn.role,
                    content: content ?? '',
                    runId: turn.runId,
                    messageId: turn.messageId,
                    hasCheckpoint: turn.hasCheckpoint,
                    thinking: turn.thinking,
                    thinkingComplete: turn.thinkingComplete,
                    thinkingDurationMs: turn.thinkingDurationMs,
                    tools: turn.tools,
                };
            })
            .filter((item): item is any => item !== null);
    }

    protected renderTranscript(): void {
        this.postToWebview({ type: 'history', messages: this.historyMessages() });
    }

    public repaintTranscript(): void {
        this.renderTranscript();
    }

    public async sendText(text: string): Promise<void> {
        if (text.trim()) await this.handleUserMessage(text);
    }

    protected appendUserTurn(text: string, messageId: string): void {
        this.transcript.push({ id: messageId, role: 'user', content: text, messageId, hasCheckpoint: false });
        this.cachedHistory.push({ role: 'user', content: text });
        this.postToWebview({ type: 'userEcho', text, messageId, hasCheckpoint: false });
        this.persistCurrentTranscript();
    }

    /**
     * Terminal agent-lifecycle phases across all bridges. OpenClaw's gateway
     * emits a successful run as phase `"end"` (terminalLifecyclePhase ?? "end"),
     * Hermes emits `"completed"`, and other providers use assorted synonyms. If
     * a terminal phase is not recognized here, `activeRunId` never clears and
     * every subsequent message is parked in the follow-up queue forever.
     */
    protected static readonly TERMINAL_LIFECYCLE_PHASES = new Set([
        'end', 'finishing', 'completed', 'complete', 'done', 'finished',
        'cancelled', 'canceled', 'aborted', 'failed', 'stopped', 'error',
    ]);

    protected isTerminalLifecyclePhase(phase: unknown): boolean {
        return typeof phase === 'string'
            && ChatBase.TERMINAL_LIFECYCLE_PHASES.has(phase.toLowerCase());
    }

    /**
     * Bare tool-result echoes that some gateways store as assistant turns
     * ("Successfully replaced 1 block(s) in /path."). They duplicate the tool
     * cards, so they are dropped when restoring history.
     */
    protected static readonly TOOL_ECHO_RE =
        /^(Successfully replaced \d+ block|Successfully (?:wrote|created|edited) |No changes made to |File (?:created|written|saved) )/i;

    /** Active run IDs scoped by session — prevents cross-chat bleed. */
    private activeRunIdsBySession = new Map<string, string>();

    protected resolveRunId(event: any, prefix: string): string {
        const direct = String(event?.runId ?? '').trim();
        if (direct) return direct;
        const session = String(event?.sessionKey ?? this.bridge.getCurrentSessionKey() ?? '').trim();
        // Check session-scoped active run first
        if (session && this.activeRunIdsBySession.has(session)) {
            return this.activeRunIdsBySession.get(session)!;
        }
        // Fall back to global activeRunId
        if (this.activeRunId) return this.activeRunId;
        if (session) return `${prefix}:${session}`;
        return `${prefix}:fallback:${++this.fallbackRunCounter}`;
    }

    protected ensureAssistantTurn(runId: string): TranscriptTurn {
        const existingId = this.runTurnIds.get(runId);
        const existing = existingId ? this.transcript.find((turn) => turn.id === existingId) : undefined;
        if (existing) return existing;

        const id = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const turn: TranscriptTurn = { id, role: 'assistant', content: '', runId };
        this.transcript.push(turn);
        this.runTurnIds.set(runId, id);
        this.postToWebview({ type: 'assistant_stream_start', runId });
        this.persistCurrentTranscript();
        return turn;
    }

    protected updateAssistantTurn(runId: string, text: string): void {
        const turn = this.ensureAssistantTurn(runId);
        turn.content = text;
        this.activeRuns.set(runId, text);
        this.cachedHistory = this.cachedHistory.filter(i => i.role !== 'assistant:' + runId);
        this.cachedHistory.push({ role: 'assistant:' + runId, content: text });
        this.postToWebview({ type: 'assistant_stream_delta', runId, fullText: text });
        this.persistCurrentTranscript();
    }

    protected markCheckpoint(messageId: string, hasCheckpoint: boolean): void {
        const turn = this.transcript.find((item) => item.messageId === messageId);
        if (turn) turn.hasCheckpoint = hasCheckpoint;
        if (hasCheckpoint) this.postToWebview({ type: 'checkpointReady', messageId });
        this.persistCurrentTranscript();
    }

    /** Push composer/webview config (send behavior, reasoning display mode). */
    protected sendConfig(): void {
        const reasoningDisplay = config().get<string>('reasoningDisplay', 'compact');
        this.postToWebview({
            type: 'config',
            sendBehavior: this.getSendBehavior(),
            reasoningDisplay,
            extraRichText: config().get<boolean>('extraRichText', true),
            activityLayout: config().get<string>('activityStream.layout', 'accordion'),
            activityRail: config().get<boolean>('activityStream.rail', true),
            activityDots: config().get<string>('activityStream.dots', 'status'),
            showFullHistory: config().get<boolean>('showFullHistory', false),
        });
    }

    /**
     * Webview boot (view-router posts `initRequest`). Smart reopen: go straight
     * to the chat view and restore history. Session-list population arrives later.
     */
    protected async handleInitRequest(): Promise<void> {
        this.sendConfig();
        this.pushModelDisplay();
        this.pushSandboxDisplay();
        this.refreshFollowUpMode();
        this.pushEnvLabel();
        this.pushScopeLabel();
        this.pushAttachedPills();
        // Ensure bridge is connected before restoring history
        try { await this.bridge.connect(); } catch (e) { /* already connected or not available */ }
        const lastKey = this.bridge.getCurrentSessionKey();
        if (lastKey) this.adoptViewSession(lastKey);
        const title = this.defaultChatTitle();
        this.postToWebview({ type: 'switchToChat', title, history: this.historyMessages() });
        this.postToWebview({ type: 'history', messages: this.historyMessages() });
        await this.restoreHistory();
        const sessionKey = this.bridge.getCurrentSessionKey();
        if (sessionKey) {
            const activeRunId = this.activeRunIdsBySession.get(sessionKey) || (this.activeRunId ? this.activeRunId : null);
            if (activeRunId) {
                this.postToWebview({ type: 'runActive', runId: activeRunId, active: true });
            }
        }
        await this.pushSessions();
    }

    protected async handleViewSessionList(): Promise<void> {
        await this.pushSessions();
        this.postToWebview({ type: 'switchToHome' });
    }

    /** Create a new chat; optionally send an initial message; show the chat view. */
    protected async handleCreateChat(text?: string): Promise<void> {
        await this.handleNewChat();
        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: [] });
        if (text && text.trim()) {
            await this.handleUserMessage(text);
        }
        await this.pushSessions();
    }

    protected async handleNewChatThenSend(text: string): Promise<void> {
        await this.handleCreateChat(text);
    }

    /** Resume an existing chat by session key. */
    protected async handleResumeSession(key: string): Promise<void> {
        if (!key) return;
        this.persistCurrentTranscript();
        const folderUri = this.bridge.getSessionToFolder().get(key)
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (folderUri) this.bridge.setActiveSession(folderUri, key);
        this.adoptViewSession(key);
        this.cachedHistory = [];
        this.transcript = [];
        this.runTurnIds.clear();
        this.activeRuns.clear();
        this.pendingNewChat = false;
        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: [] });
        this.postToWebview({ type: 'updateTitle', key, title: this.defaultChatTitle() });
        if (this.restoreTranscriptFromCache(key)) return;
        await this.restoreHistory();
    }

    protected async handleRenameSession(key: string, label: string): Promise<void> {
        if (!key || !label) return;
        try {
            await this.bridge.renameSession(key, label);
        } catch (err) {
            Logger.getInstance().warn('rename session failed', err);
        }
        this.postToWebview({ type: 'updateTitle', key, title: label });
        await this.pushSessions();
    }

    /** Archive is UI-only (hide), per ux-decisions — never sessions.delete. */
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

    /** Dynamic scope label — never the words "task"/"workspace". */
    protected pushScopeLabel(): void {
        let label: string;
        if (this.chatScope === 'all') {
            label = 'All chats';
        } else {
            const folder = vscode.workspace.workspaceFolders?.[0];
            label = folder ? folder.name : 'This folder';
        }
        this.postToWebview({ type: 'chatScopeLabel', label, scope: this.chatScope });
    }

    /** Populate the Chats list, scoped to the current binding or all bridge chats. */
    protected async pushSessions(includeArchived = false): Promise<void> {
        try {
            if (!this.bridge.capabilities.sessions) return;
            const activeKey = this.bridge.getCurrentSessionKey() ?? undefined;
            const sessions = await this.bridge.listSessions(this.chatScope, includeArchived, this.archivedKeys);
            const groups = this.buildSessionGroups(sessions);
            this.postToWebview({ type: 'renderSessions', groups, activeKey });
        } catch (err) {
            Logger.getInstance().warn('pushSessions failed', err);
        }
    }

    /**
     * Partition flat sessions into collapsible groups (Codex-style): the current
     * workspace folder first + expanded, other folders collapsed, each sorted by
     * recency. Folderless bridges return a single "Recent" group.
     */
    protected buildSessionGroups(sessions: BridgeSession[]): SessionGroup[] {
        const byId = new Map<string, SessionGroup>();
        for (const s of sessions) {
            const id = s.groupId || 'recent';
            let g = byId.get(id);
            if (!g) {
                g = { id, label: s.groupLabel || id, collapsed: !s.isCurrentGroup, sessions: [] };
                byId.set(id, g);
            }
            g.sessions.push(s);
        }
        const groups = [...byId.values()];
        for (const g of groups) {
            g.sessions.sort((a, b) => (b.lastActiveTs || 0) - (a.lastActiveTs || 0));
        }
        const recencyOf = (g: SessionGroup) => Math.max(0, ...g.sessions.map((s) => s.lastActiveTs || 0));
        const isCurrent = (g: SessionGroup) => g.sessions.some((s) => s.isCurrentGroup);
        groups.sort((a, b) => {
            const ac = isCurrent(a) ? 1 : 0, bc = isCurrent(b) ? 1 : 0;
            if (ac !== bc) return bc - ac;
            return recencyOf(b) - recencyOf(a);
        });
        return groups;
    }

    protected async handleOpenSettings(): Promise<void> {
        await vscode.commands.executeCommand('workbench.action.openSettings', this.bridge.getSettingsQuery());
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
            case 'forkRewind':
                {
                    const checkpoint = [...this.transcript].reverse().find((turn) => turn.hasCheckpoint && turn.messageId);
                    if (checkpoint?.messageId) await this.handleRewindCode(checkpoint.messageId, true);
                    else vscode.window.showInformationMessage('No checkpointed message is available to rewind.');
                }
                break;
        }
    }

    protected async handleRequestReasoningChoices(): Promise<void> {
        // Derive reasoning levels from the CURRENT model's own advertised
        // vocabulary (the children the model picker built) — never a generic
        // union. Empty if the active model advertises no reasoning efforts.
        let items: ChoiceMenuItem[] = [];
        try {
            if (this.bridge.capabilities.models) {
                const choices = await this.bridge.listModelChoices(this.currentModelId, this.currentThinking);
                const current = choices.find((c) => c.id === this.currentModelId || c.model === this.currentModelId)
                    ?? choices.find((c) => c.checked);
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

    protected async handleSelectReasoningChoice(data: any): Promise<void> {
        const effort = String(data.value ?? data.id ?? data.label ?? '').trim();
        if (!effort) return;
        this.currentThinking = effort;
        this.bridge.setSelection({ thinking: effort });
        this.pushModelDisplay();
    }

    /** Read follow-up behavior: per-bridge setting first, then global default. */
    protected refreshFollowUpMode(): void {
        const bridgeId = this.bridge?.id || '';
        const perBridgeKey = bridgeId ? `junction.${bridgeId}.followUpMode` : '';
        let mode = perBridgeKey ? config().get<string>(perBridgeKey, 'default') : 'default';
        if (!mode || mode === 'default') {
            mode = config().get<string>('followUpMode', 'queue');
        }
        this.followUpMode = (mode === 'steer' || mode === 'interrupt') ? mode : 'queue';
    }

    protected async handleRequestEnvironmentChoices(): Promise<void> {
        const items = await this.bridgeRegistry.listEnvironmentChoices();
        this.postToWebview({ type: 'environmentChoices', items });
    }

    protected async handleSelectEnvironmentChoice(data: any): Promise<void> {
        await this.bridgeRegistry.selectEnvironmentChoice(data);
        this.currentAgentId = String(data.agentId ?? '') || undefined;
        // Bridge switch is handled by registry 'changed' event — clears state + reloads.
        this.pushEnvLabel();
        this.pushModelDisplay();
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
        const sandbox = config().get<string>('sandboxMode', 'default');
        const approval = config().get<string>('approvalMode', 'default');
        this.postToWebview({
            type: 'sandboxDisplay',
            label: `${sandbox}/${approval}`,
            description: 'Local sandbox / approval preference',
        });
    }

    protected async handleRequestSandboxChoices(): Promise<void> {
        const sandbox = config().get<string>('sandboxMode', 'default');
        const approval = config().get<string>('approvalMode', 'default');
        const items: ChoiceMenuItem[] = [
            { id: 'sandbox:default', label: 'Sandbox default', section: 'Sandbox', icon: 'settings', checked: sandbox === 'default', sandboxMode: 'default' },
            { id: 'sandbox:readonly', label: 'Read only', section: 'Sandbox', icon: 'lock', checked: sandbox === 'readonly', sandboxMode: 'readonly' },
            { id: 'sandbox:workspace-write', label: 'Workspace write', section: 'Sandbox', icon: 'edit', checked: sandbox === 'workspace-write', sandboxMode: 'workspace-write' },
            { id: 'sandbox:full-access', label: 'Full access', section: 'Sandbox', icon: 'unlock', checked: sandbox === 'full-access', sandboxMode: 'full-access' },
            { id: 'approval:default', label: 'Approval default', section: 'Approvals', icon: 'settings', checked: approval === 'default', approvalMode: 'default' },
            { id: 'approval:ask', label: 'Ask', section: 'Approvals', icon: 'question', checked: approval === 'ask', approvalMode: 'ask' },
            { id: 'approval:never', label: 'Never', section: 'Approvals', icon: 'check', checked: approval === 'never', approvalMode: 'never' },
        ];
        this.postToWebview({ type: 'sandboxChoices', items });
    }

    protected async handleSelectSandboxChoice(data: any): Promise<void> {
        if (typeof data.sandboxMode === 'string') {
            await config().update('sandboxMode', data.sandboxMode, vscode.ConfigurationTarget.Global);
        }
        if (typeof data.approvalMode === 'string') {
            await config().update('approvalMode', data.approvalMode, vscode.ConfigurationTarget.Global);
        }
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
                    label: 'Models unavailable',
                    description: 'Gateway did not return model choices',
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
        this.postToWebview({ type: 'envLabel', label: this.bridge.getEnvironmentLabel() });
    }

    // ── message actions (Part B/C) ─────────────────────────────────────────────

    protected async handleForkConversation(messageId?: string): Promise<void> {
        const targetIndex = messageId
            ? this.transcript.findIndex((turn) => turn.messageId === messageId)
            : -1;
        const sourceTurns = targetIndex >= 0 ? this.transcript.slice(0, targetIndex + 1) : this.transcript;
        const context = sourceTurns
            .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
            .join('\n\n');
        await this.handleNewChat();
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const key = await this.bridge.createChat(folderUri);
        if (folderUri) this.bridge.setActiveSession(folderUri, key);
        this.pendingNewChat = false;
        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: [] });
        this.postToWebview({ type: 'updateTitle', key, title: this.defaultChatTitle() });
        if (context) {
            await this.bridge.injectMessage(key, '[Forked conversation context]\n' + context).catch(() => false);
        }
        vscode.window.showInformationMessage('Conversation forked with local transcript context.');
    }

    /** Rewind workspace code to a message's checkpoint; `fork` adds the (stubbed) fork. */
    protected async handleRewindCode(messageId?: string, fork?: boolean): Promise<void> {
        if (!messageId) return;
        if (!this.checkpoints.isEnabled()) {
            vscode.window.showInformationMessage('Checkpoints are disabled (junction.checkpoints.enabled).');
            return;
        }
        if (fork) await this.handleForkConversation(messageId);
        const choice = await vscode.window.showWarningMessage(
            'Rewind will overwrite current workspace files to the state at this message. Continue?',
            { modal: true },
            'Rewind'
        );
        if (choice !== 'Rewind') return;
        const ok = await this.checkpoints.rewindTo(messageId);
        if (ok) vscode.window.showInformationMessage('Workspace rewound to checkpoint.');
    }

    /** Open a file from a clickable file link in the chat. */
    protected async handleOpenFile(filePath: string): Promise<void> {
        if (!filePath) return;
        try {
            let line: number | undefined;
            let col: number | undefined;
            
            // Extract :line:col or :line from path
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

            // Resolve relative to workspace
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

    /** Send a slash command and capture the assistant output until the run ends. */
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
                .then((ctx) => this.bridge.sendChatMessage(command, ctx))
                .catch(() => finish());
        });
    }

    /** Heuristically extract model ids from free-form /models output. */
    protected parseModelsFromText(text: string): string[] {
        const out = new Set<string>();
        for (const line of (text || '').split(/\r?\n/)) {
            const m = line.match(/([a-z0-9][\w.\-]*\/[\w.\-:]+)/i); // provider/model
            if (m) { out.add(m[1]); continue; }
            const bare = line.match(/\b([a-z][\w.\-]{2,}(?:-[\w.]+)+)\b/i); // dashed model id
            if (bare) out.add(bare[1]);
        }
        return [...out];
    }

    protected pushModelDisplay(): void {
        this.postToWebview({ type: 'modelDisplay', model: this.currentModelDisplay, reasoning: this.currentThinking });
    }

    protected async handleAttachFile(): Promise<void> {
        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uris = await vscode.window.showOpenDialog({
            title: 'Attach file to agent thread',
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
        this.activeRunId = null;
        this.postToWebview({ type: 'history', messages: [] });
    }

    protected async handleStopRun(): Promise<void> {
        const sessionKey = this.viewSessionKey;
        if (!sessionKey || !this.activeRunId) return;
        try { await this.bridge.stopRun(sessionKey, this.activeRunId); }
        catch (err) { Logger.getInstance().error('Stop run failed', err); }
    }

    protected async handleGetUsage(): Promise<void> {
        const sessionKey = this.bridge.getCurrentSessionKey();
        if (!sessionKey) return;
        try {
            const u: any = await this.bridge.getUsage(sessionKey);
            this.postToWebview({ type: 'sessionUsage', usage: u });
            const total = (u?.inputTokens || 0) + (u?.outputTokens || 0);
            const cost = u?.cost !== undefined ? `  ·  $${u.cost}` : '';
            vscode.window.showInformationMessage(`Session usage: ${total.toLocaleString()} tokens${cost}`);
        } catch (err) { Logger.getInstance().warn('sessions.usage failed', err); }
    }

    protected async handleSlashComplete(prefix: string): Promise<void> {
        const suggestions = this.bridge.getSlashSuggestions(prefix);
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
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
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

    protected refreshLivePillFromEditor(): void {
        if (!this.livePillPath) return;
        const pill = this.createEditorPill(true);
        if (!pill) return;
        if (pill.filePath !== this.livePillPath) {
            this.attachedPills.delete(this.livePillPath);
        }
        this.addAttachedPill(pill);
    }

    protected createEditorPill(isLive: boolean): AttachedPill | null {
        const editor = vscode.window.activeTextEditor;
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
        const messageId = this.makeMessageId('m');
        this.appendUserTurn(text, messageId);
        const checkpointed = await this.snapshotCheckpoint(messageId, text);
        this.markCheckpoint(messageId, checkpointed);

        // Mid-run dispatch: if a run is active, honor junction.followUpMode.
        if (this.activeRunId) {
            this.refreshFollowUpMode();
            const savedMode = this.followUpMode;
            if (dispatchOverride === 'queue' || dispatchOverride === 'steer' || dispatchOverride === 'interrupt') {
                this.followUpMode = dispatchOverride;
            }
            const sessionKey = this.bridge.getCurrentSessionKey();
            if (this.followUpMode === 'steer' && sessionKey && this.bridge.canSteer()) {
                try {
                    await this.bridge.injectMessage(sessionKey, text);
                    this.followUpMode = savedMode;
                    return;
                } catch (err) {
                    Logger.getInstance().warn('steer (chat.inject) failed, queueing', err);
                }
            }
            if (this.followUpMode === 'interrupt' && sessionKey) {
                try { await this.bridge.stopRun(sessionKey, this.activeRunId); }
                catch (err) { Logger.getInstance().warn('interrupt abort failed', err); }
                // fall through to send
            } else {
                // queue (default / steer fallback): hold until the run finishes
                this.pendingFollowUp = this.pendingFollowUp ? this.pendingFollowUp + '\n\n' + text : text;
                this.followUpMode = savedMode;
                return;
            }
            this.followUpMode = savedMode;
        }

        await this.dispatchUserMessage(text);
    }

    /** Actually send a user message (after dispatch handling). */
    protected async dispatchUserMessage(text: string): Promise<void> {
        try {
            // Signal run active so composer disables the send button
            this.postToWebview({ type: 'runActive', active: true });
            if (this.pendingNewChat) {
                const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                const key = await this.bridge.createChat(folderUri);
                if (folderUri) this.bridge.setActiveSession(folderUri, key);
                this.adoptViewSession(key);
                this.pendingNewChat = false;
                // Auto-name the new chat from its first message (Codex-style).
                const autoTitle = this.deriveChatTitle(text) || this.defaultChatTitle();
                this.postToWebview({ type: 'updateTitle', key, title: autoTitle });
                this.bridge.renameSession(key, autoTitle).catch(() => { /* label clash / unsupported — keep default */ });
            }
            const sessionKey = this.bridge.getCurrentSessionKey();
            const fileContext = [
                this.bridge.getPendingFileContext(),
                this.buildAttachedFileContext(),
            ].filter(Boolean).join('\n\n');
            if (fileContext && sessionKey) {
                if (this.bridge.canAdminInject()) {
                    try {
                        await this.bridge.injectMessage(sessionKey, '[Workspace File Context]\n' + fileContext);
                    } catch (err) {
                        Logger.getInstance().warn('chat.inject failed, falling back to prepend', err);
                        text = fileContext + '\n\n' + text;
                    }
                } else {
                    text = fileContext + '\n\n' + text;
                }
            }
            // Bind this view to the session it sends on — the strict
            // cross-window filter drops every event for unadopted sessions.
            // Bridges may create the session inside sendChatMessage, so allow
            // lazy adoption at event time while this send is in flight.
            if (!this.viewSessionKey) {
                const preKey = this.bridge.getCurrentSessionKey();
                if (preKey) this.adoptViewSession(preKey);
                else this.pendingSessionAdoption = true;
            }
            await this.bridge.sendChatMessage(text, await this.gatherContext());
            if (!this.viewSessionKey) {
                const postKey = this.bridge.getCurrentSessionKey();
                if (postKey) this.adoptViewSession(postKey);
            }
            this.pendingSessionAdoption = false;
            // If bridge doesn't support lifecycle events, re-enable the send button.
            // If it does, finalizeRun will handle it via runActive:false.
            if (!this.bridge.canSteer() && !this.activeRunId) {
                this.postToWebview({ type: 'runComplete' });
            }
        } catch (error: any) {
            Logger.getInstance().error('dispatchUserMessage failed', error);
            vscode.window.showErrorMessage('Agent bridge error: ' + error.message);
            this.postToWebview({ type: 'response', text: 'Error: ' + error.message });
            this.postToWebview({ type: 'runComplete' });
        }
    }

    /** Snapshot the workspace at a user-turn boundary (best-effort, non-blocking). */
    protected async snapshotCheckpoint(messageId: string, label: string): Promise<boolean> {
        try { return !!(await this.checkpoints.snapshot(messageId, label)); }
        catch (err) { Logger.getInstance().warn('snapshotCheckpoint failed', err); return false; }
    }

    protected isDuplicateAssistantText(text: string): boolean {
        const normalized = String(text || '').trim();
        if (!normalized) return false;
        for (let i = this.transcript.length - 1; i >= 0; i--) {
            const turn = this.transcript[i];
            if (turn.role !== 'assistant') continue;
            return String(turn.content || '').trim() === normalized;
        }
        return false;
    }

    protected updateThinkingTurn(runId: string, text: string, complete = false, durationMs?: number): void {
        const turn = this.ensureAssistantTurn(runId);
        turn.thinking = text;
        turn.thinkingComplete = complete;
        if (durationMs !== undefined) turn.thinkingDurationMs = durationMs;
        this.persistCurrentTranscript();
    }

    protected upsertToolTurn(runId: string, event: any, formattedArgs?: string, formattedResult?: string): TranscriptTool {
        const turn = this.ensureAssistantTurn(runId);
        const toolCallId = String(event.toolCallId || `${runId}:tool:${turn.tools?.length ?? 0}`);
        if (!turn.tools) turn.tools = [];
        let tool = turn.tools.find((item) => item.toolCallId === toolCallId);
        if (!tool) {
            tool = { toolCallId };
            turn.tools.push(tool);
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
        // Ignore events from non-active bridges (stale after bridge switch)
        if (event._bridgeId && event._bridgeId !== this.bridgeRegistry.active.id) return;
        // Cross-window filter: ONLY process events for this view's session.
        // No fallbacks, no exceptions — a view with no adopted session renders
        // nothing (a fresh window must not mirror another window's run).
        const eventSession = String(event?.sessionKey ?? '').trim();
        if (!eventSession) return; // Events WITHOUT sessionKey are always blocked
        // Lazy adoption: this view sent a message before its bridge had a
        // session; adopt the one the bridge created for that send — and only
        // that one. Idle views never adopt, so they never mirror other windows.
        if (!this.viewSessionKey && this.pendingSessionAdoption) {
            const current = String(this.bridge.getCurrentSessionKey() ?? '').trim();
            if (current && eventSession === current) {
                this.adoptViewSession(current);
                this.pendingSessionAdoption = false;
            }
        }
        if (!this.viewSessionKey || eventSession !== this.viewSessionKey) return;
        if (event.type === 'agent_lifecycle' && event.phase === 'start') {
            // Stale-run guard: if a prior run never delivered a recognized
            // terminal phase, close it out now so its queued follow-up flushes
            // and the new run starts clean.
            if (this.activeRunId && this.activeRunId !== (event.runId || null)) {
                this.finalizeRun(this.activeRunId);
            }
            this.activeRunId = event.runId || null;
            // Track per-session for cross-chat isolation
            const session = String(event?.sessionKey ?? this.bridge.getCurrentSessionKey() ?? '').trim();
            if (session && this.activeRunId) {
                this.activeRunIdsBySession.set(session, this.activeRunId);
            }
            this.postToWebview({ type: 'runActive', runId: this.activeRunId, active: true });
        }

        if (event.type === 'thinking_chunk') {
            const runId = this.resolveRunId(event, 'thinking');
            if (!this.thinkingStart.has(runId)) this.thinkingStart.set(runId, Date.now());
            const buf = (this.thinkingBuffers.get(runId) || '') + (event.text || '');
            this.thinkingBuffers.set(runId, buf);
            this.updateThinkingTurn(runId, buf);
            this.postToWebview({ type: 'thinking_chunk', runId, text: event.text || '', fullText: buf });
            return;
        }

        if (event.type === 'agent_message') {
            const runId = this.resolveRunId(event, 'agent');
            const lastText = this.activeRuns.get(runId) || '';
            const nextText = this.stripReplyMarker(event.text || lastText);
            // Dedup: if this text is already displayed (from a chat_message event), skip.
            if (this.isDuplicateAssistantText(nextText)) return;
            this.updateAssistantTurn(runId, nextText);
            return;
        }

        if (event.type === 'chat_message' && event.role === 'assistant') {
            if (!this.activeRunId && this.isDuplicateAssistantText(event.content || '')) return;
            const runId = this.resolveRunId(event, 'chat');
            const lastText = this.activeRuns.get(runId) || '';
            const nextText = this.stripReplyMarker(event.content || lastText);
            this.updateAssistantTurn(runId, nextText);
            if (event.state === 'final') { this.postToWebview({ type: 'assistant_stream_end', runId }); this.activeRuns.delete(runId); }
            return;
        }

        if (event.type === 'tool_event') {
            const runId = this.resolveRunId(event, 'tool');
            this.checkpoints.recordTouchedPathsFromValue(event.args);
            this.checkpoints.recordTouchedPathsFromValue(event.result);
            if (event.phase === 'start') {
                const args = ToolEventHandler.formatToolArgs(event.args || {});
                const tool = this.upsertToolTurn(runId, event, args);
                this.postToWebview({ type: 'tool_start', runId, toolCallId: tool.toolCallId, toolName: event.toolName, args });
            } else if (event.phase === 'update') {
                const text = String(event.result || '');
                const tool = this.upsertToolTurn(runId, event, undefined, text);
                this.postToWebview({ type: 'tool_update', toolCallId: tool.toolCallId, text });
            } else if (event.phase === 'result') {
                const result = ToolEventHandler.formatToolResult(event.result || '', event.isError || false);
                const tool = this.upsertToolTurn(runId, event, undefined, result);
                this.postToWebview({ type: 'tool_result', toolCallId: tool.toolCallId, result, isError: event.isError || false });
            }
            return;
        }

        if (event.type === 'agent_lifecycle' && this.isTerminalLifecyclePhase(event.phase)) {
            this.finalizeRun(this.resolveRunId(event, 'agent'), event.usage);
        }

        if ((event.type === 'agent' || event.type === 'chat') && (event.payload || event).sessionKey) {
            const payload = event.payload || event;
            if (payload.sessionKey.includes(':subagent:') || payload.spawnedBy) {
                this.postToWebview({ type: 'subagentInfo', runId: event.runId, sessionKey: payload.sessionKey, spawnedBy: payload.spawnedBy, subagentRole: payload.subagentRole, spawnDepth: payload.spawnDepth });
            }
        }
    }

    /**
     * Close out a run: end its assistant stream, clear active state, flush the
     * thinking buffer, report usage, and dispatch any queued follow-up. Safe to
     * call from the terminal-phase branch or the stale-run guard.
     */
    protected finalizeRun(runId: string, usage?: { inputTokens?: number; outputTokens?: number }): void {
        this.postToWebview({ type: 'assistant_stream_end', runId });
        this.activeRuns.delete(runId);
        // Clear per-session tracking for this runId
        for (const [session, rid] of this.activeRunIdsBySession) {
            if (rid === runId) this.activeRunIdsBySession.delete(session);
        }
        if (this.activeRunId === runId || this.activeRunId === null) {
            this.activeRunId = null;
            this.postToWebview({ type: 'runActive', active: false });
        }
        const thinkingBuf = this.thinkingBuffers.get(runId);
        if (thinkingBuf) {
            const startedAt = this.thinkingStart.get(runId);
            const durationMs = startedAt ? Date.now() - startedAt : 0;
            this.updateThinkingTurn(runId, thinkingBuf, true, durationMs);
            this.postToWebview({ type: 'thinking_end', runId, tokenCount: thinkingBuf.length, durationMs });
            this.thinkingBuffers.delete(runId);
            this.thinkingStart.delete(runId);
        }
        if (usage) {
            this.postToWebview({ type: 'tokenUsage', runId, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0 });
        }

        // Flush any queued follow-up message now that the run has finished.
        if (this.pendingFollowUp) {
            const queued = this.pendingFollowUp;
            this.pendingFollowUp = null;
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
            selection: editor?.selection ? { start: editor.selection.start.line, end: editor.selection.end.line } : null
        };
    }

    protected async restoreHistory(): Promise<void> {
        try {
            const history = await this.bridge.getSessionHistory(200);
            const messages = Array.isArray(history?.messages) ? history.messages : history?.payload?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                this.renderTranscript();
                return;
            }
            const turns = this.rebuildTurnsFromGatewayHistory(messages);
            if (turns.length > this.transcript.length) {
                this.transcript = turns;
                this.cachedHistory = turns.map((turn) => ({ role: turn.role, content: turn.content }));
            }
            this.renderTranscript();
            this.persistCurrentTranscript();
        } catch (error: any) { Logger.getInstance().warn('restoreHistory failed', error); }
    }

    /** Load full history (up to 1000 turns) when user clicks 'See more'. */
    protected async handleLoadMoreHistory(): Promise<void> {
        try {
            const history = await this.bridge.getSessionHistory(1000);
            const messages = Array.isArray(history?.messages) ? history.messages : history?.payload?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                this.postToWebview({ type: 'noMoreHistory' });
                return;
            }
            const turns = this.rebuildTurnsFromGatewayHistory(messages);
            if (turns.length > this.transcript.length) {
                this.transcript = turns;
                this.cachedHistory = turns.map((turn) => ({ role: turn.role, content: turn.content }));
            }
            this.renderTranscript();
            this.persistCurrentTranscript();
            // 1000 is gateway max — no more after this
            this.postToWebview({ type: 'noMoreHistory' });
        } catch (error: any) { Logger.getInstance().warn('handleLoadMoreHistory failed', error); }
    }

    /** Load history from JSONL file for infinite scroll (when showFullHistory is enabled). */
    protected async handleLoadMoreHistoryFromJsonl(offset: number = 0): Promise<void> {
        try {
            const sessionKey = this.bridge.getCurrentSessionKey();
            if (!sessionKey || !this.bridge.getSessionHistoryFromJsonl) {
                // No session or bridge doesn't support JSONL — fall back to gateway
                await this.handleLoadMoreHistory();
                return;
            }
            const result = await this.bridge.getSessionHistoryFromJsonl(sessionKey, offset, 256 * 1024);
            if (!result || !result.messages || result.messages.length === 0) {
                // Unavailable or empty — fall back to gateway history
                await this.handleLoadMoreHistory();
                return;
            }
            const turns = this.rebuildTurnsFromGatewayHistory(result.messages);
            this.postToWebview({
                type: 'moreHistory',
                turns,
                hasMore: result.hasMore,
                nextOffset: result.nextOffset
            });
        } catch (error: any) { Logger.getInstance().warn('handleLoadMoreHistoryFromJsonl failed', error); }
    }

    /**
     * Some models route their reasoning through plain text and separate the
     * user-visible reply with this marker (OpenClaw convention). Everything
     * before it is thinking; everything after is the actual message.
     */
    protected static readonly REPLY_MARKER = '[[reply_to_current]]';

    /** Drop any reasoning prefix ahead of the reply marker (live stream safety). */
    protected stripReplyMarker(text: string): string {
        const idx = text.indexOf(ChatBase.REPLY_MARKER);
        return idx === -1 ? text : text.slice(idx + ChatBase.REPLY_MARKER.length).trimStart();
    }

    /**
     * Rebuild full transcript turns from gateway history, shaped like a Codex
     * transcript: one assistant turn per user→reply cycle. OpenClaw stores a
     * run as MANY assistant messages (thinking parts, narration, toolCall
     * parts) interleaved with `role:'toolResult'` records keyed by
     * `toolCallId`. Merging the run keeps the webview compact — reasoning goes
     * to the collapsed thinking disclosure, tool calls to the activity
     * accordion, and only real prose stays as message text.
     */
    protected rebuildTurnsFromGatewayHistory(messages: any[]): TranscriptTurn[] {
        const turns: TranscriptTurn[] = [];
        const toolIndex = new Map<string, TranscriptTool>();
        let current: TranscriptTurn | null = null;
        let thinkingBuf: string[] = [];
        let contentBuf: string[] = [];

        const flush = () => {
            if (!current) return;
            current.content = contentBuf.join('\n\n');
            const thinking = thinkingBuf.join('\n\n');
            if (thinking) {
                current.thinking = thinking;
                current.thinkingComplete = true;
            }
            if (current.tools && current.tools.length === 0) current.tools = undefined;
            if (current.content || current.thinking || current.tools?.length) turns.push(current);
            current = null;
            thinkingBuf = [];
            contentBuf = [];
        };

        // Route a text chunk: reasoning before the reply marker goes to the
        // thinking buffer, the rest to visible content.
        const route = (raw: string, defaultToThinking: boolean) => {
            const t = String(raw ?? '').trim();
            if (!t) return;
            const idx = t.indexOf(ChatBase.REPLY_MARKER);
            if (idx >= 0) {
                const before = t.slice(0, idx).trim();
                const after = t.slice(idx + ChatBase.REPLY_MARKER.length).trim();
                if (before) thinkingBuf.push(before);
                if (after) contentBuf.push(after);
                return;
            }
            (defaultToThinking ? thinkingBuf : contentBuf).push(t);
        };

        for (const msg of messages) {
            const m = msg?.message ?? msg;
            const role = msg?.role || m?.role;
            if (role === 'user') {
                flush();
                const content = this.extractHistoryText(msg);
                const visible = content ? this.visibleTurnContent('user', content) : null;
                if (visible) {
                    turns.push({ id: this.makeMessageId('m'), role: 'user', content: visible });
                }
                continue;
            }
            if (role === 'assistant') {
                if (!current) {
                    current = { id: this.makeMessageId('a'), role: 'assistant', content: '', tools: [] };
                }
                const parts = Array.isArray(m?.content)
                    ? m.content
                    : (typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);
                for (const part of parts) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.type === 'thinking' || part.type === 'reasoning') {
                        route(String(part.thinking ?? part.text ?? ''), true);
                        continue;
                    }
                    if (part.type === 'toolCall' || part.type === 'tool_use' || part.type === 'tool-call') {
                        const tool: TranscriptTool = {
                            toolCallId: String(part.id ?? part.toolCallId ?? `restored:${toolIndex.size}`),
                            toolName: String(part.name ?? part.toolName ?? ''),
                            args: ToolEventHandler.formatToolArgs(part.arguments ?? part.input ?? part.args ?? {}),
                            phase: 'start',
                        };
                        current.tools!.push(tool);
                        toolIndex.set(tool.toolCallId, tool);
                        continue;
                    }
                    if (typeof part.text === 'string') {
                        const visible = this.visibleTurnContent('assistant', part.text);
                        if (visible && !ChatBase.TOOL_ECHO_RE.test(visible.trim())) route(visible, false);
                    }
                }
                continue;
            }
            if (role === 'toolResult' || role === 'tool' || role === 'tool_result') {
                const id = String(m?.toolCallId ?? m?.tool_call_id ?? '');
                const tool = id ? toolIndex.get(id) : undefined;
                if (tool) {
                    const resultText = this.extractHistoryText(msg);
                    tool.result = ToolEventHandler.formatToolResult(resultText || m?.content || '', !!m?.isError);
                    tool.isError = !!m?.isError;
                    tool.phase = 'result';
                    if (m?.toolName && !tool.toolName) tool.toolName = String(m.toolName);
                }
                continue;
            }
            // Session meta / model-change records: neither chat turns nor run
            // boundaries — keep the current assistant run open.
        }
        flush();
        return turns;
    }

    protected pushToolStatus(): void {
        const status = this.bridge.getToolStatus();
        if (status) {
            this.postToWebview({ type: 'toolStatus', activeTools: status.tools.filter(t => t.enabled).map(t => t.name), totalTools: status.tools.length });
        }
    }
}
