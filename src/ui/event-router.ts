/**
 * EventRouter — dispatches webview onDidReceiveMessage events to the
 * appropriate handlers on ChatBase.
 *
 * Extracted from the large switch statement in chatBase.ts for modularity.
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import type { ConfigManager } from './config-manager';

const UI_ONLY_MESSAGE_TYPES = new Set([
    'attachCurrentFile',
    'addPill',
    'removePill',
    'toggleLivePill',
    'listWorkspaceFiles',
    'requestModelChoices',
    'selectModelChoice',
    'requestReasoningChoices',
    'selectReasoningChoice',
    'requestEnvironmentChoices',
    'selectEnvironmentChoice',
    'requestSandboxChoices',
    'selectSandboxChoice',
    'selectHeaderAction',
    'copyToClipboard',
    'openFile',
    'forkConversation',
    'rewindToMessage',
    'setReaction',
    'openSettings',
    'getUsage',
    'loadMoreHistory',
    'loadMoreHistoryFromJsonl',
]);

/**
 * Type alias for handler function references. Each corresponds to a
 * protected method on ChatBase.
 */
export interface ChatBaseHandlers {
    handleInitRequest(): Promise<void>;
    handleUserMessage(text: string, dispatchOverride?: string): Promise<void>;
    handleStopRun(): Promise<void>;
    handleAttachFile(): Promise<void>;
    handleAttachPastedFile(data: any): void;
    handleSlashComplete(prefix: string): Promise<void>;
    handleCreateChat(text?: string): Promise<void>;
    handleNewChatThenSend(text: string): Promise<void>;
    handleResumeSession(key: string): Promise<void>;
    handleViewSessionList(): Promise<void>;
    handleRenameSession(key: string, label: string): Promise<void>;
    handleArchiveSession(key: string): Promise<void>;
    handleShowArchived(show: boolean): Promise<void>;
    handleSetChatScope(scope: string): Promise<void>;
    handleRequestModelChoices(): Promise<void>;
    handleSelectModelChoice(data: any): Promise<void>;
    handleRequestReasoningChoices(): Promise<void>;
    handleSelectReasoningChoice(data: any): Promise<void>;
    handleRequestEnvironmentChoices(): Promise<void>;
    handleSelectEnvironmentChoice(data: any): Promise<void>;
    handleRequestSandboxChoices(): Promise<void>;
    handleSelectSandboxChoice(data: any): Promise<void>;
    handleHeaderAction(data: any): Promise<void>;
    handleListWorkspaceFiles(prefix?: string): Promise<void>;
    addFilePill(uri?: vscode.Uri): void;
    handleAddPill(data: any): void;
    handleRemovePill(filePath?: string): void;
    handleToggleLivePill(enabled: boolean): void;
    handleEditQueuedFollowUp(index: number, text: string): void;
    handleMoveQueuedFollowUp(index: number, direction: 'up' | 'down'): void;
    handleReorderQueuedFollowUps(order: string[]): void;
    handleToggleQueuedFollowUpGroup(index: number): void;
    handleSteerQueuedFollowUp(index: number, id?: string): Promise<void>;
    handleRemoveQueuedFollowUp(index: number): void;
    handleLoadMoreHistory(): Promise<void>;
    handleLoadMoreHistoryFromJsonl(offset: number): Promise<void>;
    handleOpenSettings(): Promise<void>;
    handleGetUsage(): Promise<void>;
    handleForkConversation(messageId?: string): Promise<void>;
    handleRewindToMessage(messageId?: string): Promise<void>;
    handleOpenFile(filePath: string): Promise<void>;
    handleSetReaction(messageId: string, value: 'up' | 'down' | null): Promise<void>;
    postToWebview(message: any): void;
}

export class EventRouter {
    constructor(private readonly handlers: ChatBaseHandlers) {}

    /** The config manager (or a saveAnimConfig delegate). */
    configManager: ConfigManager | null = null;

    /**
     * Process a single webview message and dispatch to the correct handler.
     * Returns when the handler completes or an error is caught/reported.
     */
    async handleMessage(data: any): Promise<void> {
        try {
            switch (data.type) {
                // boot
                case 'ready':
                    await this.handlers.handleInitRequest();
                    break;
                case 'initRequest':
                    await this.handlers.handleInitRequest();
                    break;
                // composer
                case 'sendMessage':
                    await this.handlers.handleUserMessage(data.text, data.dispatchOverride);
                    break;
                case 'stopRun':
                    await this.handlers.handleStopRun();
                    break;
                case 'consoleError':
                    Logger.getInstance().error('[webview]', data.text);
                    break;
                case 'attachFile':
                    await this.handlers.handleAttachFile();
                    break;
                case 'attachPastedFile':
                    this.handlers.handleAttachPastedFile(data);
                    break;
                case 'slashComplete':
                    await this.handlers.handleSlashComplete(data.prefix);
                    break;
                // chats list / header (module vocabulary)
                case 'createChat':
                    await this.handlers.handleCreateChat(data.text);
                    break;
                case 'newChat':
                    await this.handlers.handleCreateChat(undefined);
                    break;
                case 'newChatThenSend':
                    await this.handlers.handleNewChatThenSend(data.text);
                    break;
                case 'resumeSession':
                    await this.handlers.handleResumeSession(data.key);
                    break;
                case 'backToSessions':
                    await this.handlers.handleViewSessionList();
                    break;
                case 'viewSessionList':
                    await this.handlers.handleViewSessionList();
                    break;
                case 'renameSession':
                    await this.handlers.handleRenameSession(data.key, data.label);
                    break;
                case 'archiveSession':
                    await this.handlers.handleArchiveSession(data.key);
                    break;
                case 'showArchivedSessions':
                    await this.handlers.handleShowArchived(!!data.show);
                    break;
                case 'setChatScope':
                    await this.handlers.handleSetChatScope(data.scope);
                    break;
                // footer/header choice menus
                case 'requestModelChoices':
                    await this.handlers.handleRequestModelChoices();
                    break;
                case 'selectModelChoice':
                    await this.handlers.handleSelectModelChoice(data);
                    break;
                case 'requestReasoningChoices':
                    await this.handlers.handleRequestReasoningChoices();
                    break;
                case 'selectReasoningChoice':
                    await this.handlers.handleSelectReasoningChoice(data);
                    break;
                case 'requestEnvironmentChoices':
                    await this.handlers.handleRequestEnvironmentChoices();
                    break;
                case 'selectEnvironmentChoice':
                    await this.handlers.handleSelectEnvironmentChoice(data);
                    break;
                case 'selectAgentChoice':
                    // Agent entries are child items from the environment picker.
                    await this.handlers.handleSelectEnvironmentChoice(data);
                    break;
                case 'requestSandboxChoices':
                    await this.handlers.handleRequestSandboxChoices();
                    break;
                case 'selectSandboxChoice':
                    await this.handlers.handleSelectSandboxChoice(data);
                    break;
                case 'selectHeaderAction':
                    await this.handlers.handleHeaderAction(data);
                    break;
                // attached file/context pills
                case 'listWorkspaceFiles':
                    await this.handlers.handleListWorkspaceFiles(data.prefix);
                    break;
                case 'attachCurrentFile':
                    this.handlers.addFilePill();
                    break;
                case 'addPill':
                    this.handlers.handleAddPill(data);
                    break;
                case 'removePill':
                    this.handlers.handleRemovePill(data.filePath);
                    break;
                case 'toggleLivePill':
                    this.handlers.handleToggleLivePill(!!data.enabled);
                    break;
                // Queued follow-ups are messages typed while a run is active.
                case 'editQueuedFollowUp':
                    this.handlers.handleEditQueuedFollowUp(Number(data.index), String(data.text ?? ''));
                    break;
                case 'moveQueuedFollowUp':
                    this.handlers.handleMoveQueuedFollowUp(Number(data.index), data.direction === 'up' ? 'up' : 'down');
                    break;
                case 'reorderQueuedFollowUps':
                    this.handlers.handleReorderQueuedFollowUps(Array.isArray(data.order) ? data.order.map(String) : []);
                    break;
                case 'toggleQueuedFollowUpGroup':
                    this.handlers.handleToggleQueuedFollowUpGroup(Number(data.index));
                    break;
                case 'steerQueuedFollowUp':
                    await this.handlers.handleSteerQueuedFollowUp(Number(data.index), data.id ? String(data.id) : undefined);
                    break;
                case 'removeQueuedFollowUp':
                    this.handlers.handleRemoveQueuedFollowUp(Number(data.index));
                    break;
                // header
                case 'loadMoreHistory':
                    await this.handlers.handleLoadMoreHistory();
                    break;
                case 'loadMoreHistoryFromJsonl':
                    await this.handlers.handleLoadMoreHistoryFromJsonl(data.offset);
                    break;
                case 'openSettings':
                    await this.handlers.handleOpenSettings();
                    break;
                case 'getUsage':
                    await this.handlers.handleGetUsage();
                    break;
                // message actions (Part B/C)
                case 'forkConversation':
                    await this.handlers.handleForkConversation(data.messageId);
                    break;
                case 'rewindToMessage':
                    await this.handlers.handleRewindToMessage(data.messageId);
                    break;
                case 'openFile':
                    await this.handlers.handleOpenFile(data.filePath);
                    break;
                case 'copyToClipboard':
                    await vscode.env.clipboard.writeText(data.text || '');
                    break;
                case 'setReaction':
                    await this.handlers.handleSetReaction(data.messageId, data.value);
                    break;
                case 'saveAnimConfig':
                    if (this.configManager) {
                        await this.configManager.saveAnimConfig(data);
                    }
                    break;
                case 'saveBubbleConfig':
                    await vscode.workspace.getConfiguration('junction').update('bubble.radius', data.radius ?? 16, vscode.ConfigurationTarget.Global);
                    await vscode.workspace.getConfiguration('junction').update('bubble.tip', data.tip ?? 'none', vscode.ConfigurationTarget.Global);
                    break;
            }
        } catch (error: any) {
            const message = error?.message || String(error);
            Logger.getInstance().error('webview message handler failed', error);
            if (UI_ONLY_MESSAGE_TYPES.has(String(data?.type || ''))) {
                vscode.window.showWarningMessage(message);
                return;
            }
            this.handlers.postToWebview({ type: 'response', text: 'Error: ' + message });
            this.handlers.postToWebview({ type: 'runComplete' });
        }
    }
}
