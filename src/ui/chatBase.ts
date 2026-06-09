import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Logger } from '../utils/logger';
import { ToolEventHandler } from './toolEventHandler';
import { CheckpointManager } from '../checkpoints/checkpointManager';
import { createHiddenPlanReviewState, PlanReviewState } from './planReviewMode';
import { BridgeRegistry } from '../bridges/registry';
import { ChoiceMenuItem } from '../bridges/types';
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
}

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
    protected currentThinking: string | undefined;
    protected currentAgentId: string | undefined;
    protected followUpMode: 'queue' | 'steer' | 'interrupt' = 'queue';
    protected pendingFollowUp: string | null = null;
    protected archivedKeys = new Set<string>();
    protected chatScope: 'folder' | 'all' = 'folder';
    protected attachedPills = new Map<string, AttachedPill>();
    protected livePillPath: string | null = null;
    protected currentModelId: string | undefined;
    protected planReviewState: PlanReviewState = createHiddenPlanReviewState();
    protected pendingNewChat = false;

    constructor(
        protected readonly extensionUri: vscode.Uri,
        protected readonly bridgeRegistry: BridgeRegistry
    ) {
        this.checkpoints = new CheckpointManager(bridgeRegistry.context);
        this.bridgeRegistry.on('changed', () => {
            this.cachedHistory = [];
            this.transcript = [];
            this.runTurnIds.clear();
            this.activeRuns.clear();
            this.activeRunId = null;
            this.currentModelDisplay = '';
            this.currentModelId = undefined;
            this.currentThinking = undefined;
            void this.handleInitRequest();
        });
    }

    protected get bridge() {
        return this.bridgeRegistry.active;
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
            switch (data.type) {
                // boot
                case 'ready': await this.handleInitRequest(); break;
                case 'initRequest': await this.handleInitRequest(); break;
                // composer
                case 'sendMessage': await this.handleUserMessage(data.text, data.dispatchOverride); break;
                case 'stopRun': await this.handleStopRun(); break;
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
                case 'updateAttachedFileCount': break;
                // header
                case 'openSettings': await this.handleOpenSettings(); break;
                case 'openExternalComposer': await this.openExternalComposer(data.text); break;
                case 'getUsage': await this.handleGetUsage(); break;
                // message actions (Part B/C)
                case 'forkConversation': await this.handleForkConversation(data.messageId); break;
                case 'rewindCode': await this.handleRewindCode(data.messageId, !!data.fork); break;
            }
        });

        for (const bridge of this.bridgeRegistry.getAll()) {
            bridge.on('stream', (event: any) => this.handleStreamEvent(event));
        }
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

    protected historyMessages(): Array<{ role: string; content: string; messageId?: string; hasCheckpoint?: boolean }> {
        return this.transcript.map((turn) => ({
            role: turn.role,
            content: turn.content,
            messageId: turn.messageId,
            hasCheckpoint: turn.hasCheckpoint,
        }));
    }

    protected renderTranscript(): void {
        this.postToWebview({ type: 'history', messages: this.historyMessages() });
    }

    public repaintTranscript(): void {
        this.renderTranscript();
    }

    protected appendUserTurn(text: string, messageId: string): void {
        this.transcript.push({ id: messageId, role: 'user', content: text, messageId, hasCheckpoint: false });
        this.cachedHistory.push({ role: 'user', content: text });
        this.postToWebview({ type: 'userEcho', text, messageId, hasCheckpoint: false });
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

    protected resolveRunId(event: any, prefix: string): string {
        const direct = String(event?.runId ?? '').trim();
        if (direct) return direct;
        if (this.activeRunId) return this.activeRunId;
        const session = String(event?.sessionKey ?? '').trim();
        const ts = String(event?.timestamp ?? '').trim();
        if (session && ts) return `${prefix}:${session}:${ts}`;
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
        return turn;
    }

    protected updateAssistantTurn(runId: string, text: string): void {
        const turn = this.ensureAssistantTurn(runId);
        turn.content = text;
        this.activeRuns.set(runId, text);
        this.cachedHistory = this.cachedHistory.filter(i => i.role !== 'assistant:' + runId);
        this.cachedHistory.push({ role: 'assistant:' + runId, content: text });
        this.postToWebview({ type: 'assistant_stream_delta', runId, fullText: text });
    }

    protected markCheckpoint(messageId: string, hasCheckpoint: boolean): void {
        const turn = this.transcript.find((item) => item.messageId === messageId);
        if (turn) turn.hasCheckpoint = hasCheckpoint;
        if (hasCheckpoint) this.postToWebview({ type: 'checkpointReady', messageId });
    }

    /** Push composer/webview config (send behavior, reasoning display mode). */
    protected sendConfig(): void {
        const reasoningDisplay = config().get<string>('reasoningDisplay', 'expanded');
        this.postToWebview({ type: 'config', sendBehavior: this.getSendBehavior(), reasoningDisplay });
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
        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: this.historyMessages() });
        await this.restoreHistory();
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
        const folderUri = this.bridge.getSessionToFolder().get(key)
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (folderUri) this.bridge.setActiveSession(folderUri, key);
        this.cachedHistory = [];
        this.transcript = [];
        this.runTurnIds.clear();
        this.activeRuns.clear();
        this.pendingNewChat = false;
        this.postToWebview({ type: 'switchToChat', title: this.defaultChatTitle(), history: [] });
        this.postToWebview({ type: 'updateTitle', key, title: this.defaultChatTitle() });
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
            this.postToWebview({ type: 'renderSessions', sessions, activeKey });
        } catch (err) {
            Logger.getInstance().warn('pushSessions failed', err);
        }
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
                await this.handleForkConversation();
                break;
        }
    }

    protected async handleRequestReasoningChoices(): Promise<void> {
        const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'];
        const items = levels.map((level): ChoiceMenuItem => ({
            id: level,
            label: level,
            description: level === 'off' ? 'No compact reasoning' : 'Compact reasoning effort',
            checked: level === this.currentThinking,
        }));
        this.postToWebview({ type: 'reasoningChoices', items });
    }

    protected async handleSelectReasoningChoice(data: any): Promise<void> {
        const effort = String(data.value ?? data.id ?? data.label ?? '').trim();
        if (!effort) return;
        this.currentThinking = effort;
        this.bridge.setSelection({ thinking: effort });
        this.pushModelDisplay();
    }

    /** Read hidden mid-run follow-up behavior from settings. No default UI chip. */
    protected refreshFollowUpMode(): void {
        const cfg = config().get<string>('followUpMode', 'queue');
        this.followUpMode = (cfg === 'steer' || cfg === 'interrupt') ? cfg : 'queue';
    }

    protected async handleRequestEnvironmentChoices(): Promise<void> {
        const items = await this.bridgeRegistry.listEnvironmentChoices();
        this.postToWebview({ type: 'environmentChoices', items });
    }

    protected async handleSelectEnvironmentChoice(data: any): Promise<void> {
        await this.bridgeRegistry.selectEnvironmentChoice(data);
        this.currentAgentId = String(data.agentId ?? '') || undefined;
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
        this.pendingNewChat = true;
        this.cachedHistory = [];
        this.transcript = [];
        this.runTurnIds.clear();
        this.activeRuns.clear();
        this.activeRunId = null;
        this.postToWebview({ type: 'history', messages: [] });
    }

    protected async handleStopRun(): Promise<void> {
        const sessionKey = this.bridge.getCurrentSessionKey();
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

    public async sendExternalComposerText(text: string): Promise<void> {
        if (text.trim()) await this.handleUserMessage(text);
    }

    public async openExternalComposer(text?: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: text || '',
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
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
        this.postToWebview({ type: 'updateFileCount', count: this.attachedPills.size });
    }

    protected handleToggleLivePill(enabled: boolean): void {
        if (!enabled) {
            if (this.livePillPath) this.attachedPills.delete(this.livePillPath);
            this.livePillPath = null;
            this.postToWebview({ type: 'updateLivePill', enabled: false });
            this.postToWebview({ type: 'updateFileCount', count: this.attachedPills.size });
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
        this.postToWebview({ type: 'updateFileCount', count: this.attachedPills.size });
    }

    protected pushAttachedPills(): void {
        for (const pill of this.attachedPills.values()) {
            this.postToWebview({
                type: pill.isLive ? 'updateLivePill' : 'addPill',
                ...pill,
                enabled: pill.isLive ? true : undefined,
            });
        }
        this.postToWebview({ type: 'updateFileCount', count: this.attachedPills.size });
    }

    protected buildAttachedFileContext(): string {
        this.refreshLivePillFromEditor();
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
            if (this.pendingNewChat) {
                const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                const key = await this.bridge.createChat(folderUri);
                if (folderUri) this.bridge.setActiveSession(folderUri, key);
                this.pendingNewChat = false;
                this.postToWebview({ type: 'updateTitle', key, title: this.defaultChatTitle() });
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
            await this.bridge.sendChatMessage(text, await this.gatherContext());
        } catch (error: any) {
            vscode.window.showErrorMessage('Agent bridge error: ' + error.message);
            this.postToWebview({ type: 'response', text: 'Error: ' + error.message });
        }
    }

    /** Snapshot the workspace at a user-turn boundary (best-effort, non-blocking). */
    protected async snapshotCheckpoint(messageId: string, label: string): Promise<boolean> {
        try { return !!(await this.checkpoints.snapshot(messageId, label)); }
        catch (err) { Logger.getInstance().warn('snapshotCheckpoint failed', err); return false; }
    }

    protected handleStreamEvent(event: any): void {
        if (event.type === 'agent_lifecycle' && event.phase === 'start') {
            // Stale-run guard: if a prior run never delivered a recognized
            // terminal phase, close it out now so its queued follow-up flushes
            // and the new run starts clean.
            if (this.activeRunId && this.activeRunId !== (event.runId || null)) {
                this.finalizeRun(this.activeRunId);
            }
            this.activeRunId = event.runId || null;
            this.postToWebview({ type: 'runActive', runId: this.activeRunId, active: true });
        }

        if (event.type === 'thinking_chunk') {
            const runId = event.runId || 'current';
            if (!this.thinkingStart.has(runId)) this.thinkingStart.set(runId, Date.now());
            const buf = (this.thinkingBuffers.get(runId) || '') + (event.text || '');
            this.thinkingBuffers.set(runId, buf);
            this.postToWebview({ type: 'thinking_chunk', runId, text: event.text || '', fullText: buf });
            return;
        }

        if (event.type === 'agent_message') {
            const runId = this.resolveRunId(event, 'agent');
            const lastText = this.activeRuns.get(runId) || '';
            const nextText = event.text || lastText;
            this.updateAssistantTurn(runId, nextText);
            return;
        }

        if (event.type === 'chat_message' && event.role === 'assistant') {
            const runId = this.resolveRunId(event, 'chat');
            const lastText = this.activeRuns.get(runId) || '';
            const nextText = event.content || lastText;
            this.updateAssistantTurn(runId, nextText);
            if (event.state === 'final') { this.postToWebview({ type: 'assistant_stream_end', runId }); this.activeRuns.delete(runId); }
            return;
        }

        if (event.type === 'tool_event') {
            this.checkpoints.recordTouchedPathsFromValue(event.args);
            this.checkpoints.recordTouchedPathsFromValue(event.result);
            if (event.phase === 'start') {
                this.postToWebview({ type: 'tool_start', runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, args: ToolEventHandler.formatToolArgs(event.args || {}) });
            } else if (event.phase === 'update') {
                this.postToWebview({ type: 'tool_update', toolCallId: event.toolCallId, text: event.result || '' });
            } else if (event.phase === 'result') {
                this.postToWebview({ type: 'tool_result', toolCallId: event.toolCallId, result: ToolEventHandler.formatToolResult(event.result || '', event.isError || false), isError: event.isError || false });
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
        if (this.activeRunId === runId || this.activeRunId === null) {
            this.activeRunId = null;
            this.postToWebview({ type: 'runActive', active: false });
        }
        const thinkingBuf = this.thinkingBuffers.get(runId);
        if (thinkingBuf) {
            const startedAt = this.thinkingStart.get(runId);
            const durationMs = startedAt ? Date.now() - startedAt : 0;
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
            activeFile: editor?.document.fileName,
            language: editor?.document.languageId,
            selection: editor?.selection ? { start: editor.selection.start.line, end: editor.selection.end.line } : null
        };
    }

    protected async restoreHistory(): Promise<void> {
        if (this.transcript.length > 0) {
            this.renderTranscript();
            return;
        }
        if (this.cachedHistory.length > 0) {
            this.transcript = this.cachedHistory.map((i) => ({
                id: this.makeMessageId(i.role.startsWith('assistant:') ? 'a' : 'm'),
                role: i.role.startsWith('assistant:') ? 'assistant' : 'user',
                content: i.content,
            }));
            this.renderTranscript();
            return;
        }
        try {
            const history = await this.bridge.getSessionHistory(50);
            const messages = Array.isArray(history?.messages) ? history.messages : history?.payload?.messages;
            if (Array.isArray(messages)) {
                const normalized = messages
                    .map((msg: any) => {
                        const role = msg.role || msg?.message?.role;
                        const content = msg.text || msg?.message?.text || msg?.message?.content?.[0]?.text;
                        return (role && content) ? { role, content } : null;
                    })
                    .filter(Boolean) as Array<{ role: string; content: string }>;
                if (normalized.length > 0) {
                    this.cachedHistory = normalized;
                    this.transcript = normalized.map((item) => ({
                        id: this.makeMessageId(item.role === 'assistant' ? 'a' : 'm'),
                        role: item.role === 'assistant' ? 'assistant' : 'user',
                        content: item.content,
                    }));
                    this.renderTranscript();
                }
            }
        } catch (error: any) { Logger.getInstance().warn('restoreHistory failed', error); }
    }

    protected pushToolStatus(): void {
        const status = this.bridge.getToolStatus();
        if (status) {
            this.postToWebview({ type: 'toolStatus', activeTools: status.tools.filter(t => t.enabled).map(t => t.name), totalTools: status.tools.length });
        }
    }
}
