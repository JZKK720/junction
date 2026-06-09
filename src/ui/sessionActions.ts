import * as vscode from 'vscode';
import { GatewayConnection } from '../gateway/connection';
import { SessionManager } from '../gateway/sessionManager';
import * as folderSessions from '../gateway/folderSessions';
import { SessionEntry } from '../types/openclaw';
import { Logger } from '../utils/logger';

// ──────────────────────────────────────────────
// Extended state: FolderSessionState + archivedKeys
// ──────────────────────────────────────────────

interface ExtendedFolderState extends folderSessions.FolderSessionState {
    archivedKeys?: string[];
}

// ──────────────────────────────────────────────
// Session card shape sent to webview
// ──────────────────────────────────────────────

interface SessionCard {
    key: string;
    title: string;
    model: string;
    messageCount: number;
    isActive: boolean;
}

// ──────────────────────────────────────────────
// SessionActions — middleware for session lifecycle
// ──────────────────────────────────────────────

export class SessionActions {
    private logger: Logger;

    constructor(
        private sessionManager: SessionManager,
        private gateway: GatewayConnection
    ) {
        this.logger = Logger.getInstance();
    }

    private get ctx(): vscode.ExtensionContext {
        return this.sessionManager.context;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    /** Read per-folder workspace state (with archivedKeys extension). */
    private getState(folderUri: vscode.Uri): ExtendedFolderState | undefined {
        return folderSessions.getSessionState(this.ctx, folderUri) as
            | ExtendedFolderState
            | undefined;
    }

    /** Derive a display title from a session entry. */
    private sessionTitle(entry: SessionEntry): string {
        return entry.label || entry.key;
    }

    /** Convert a SessionEntry to a webview session card. */
    private toCard(entry: SessionEntry, activeKey?: string): SessionCard {
        return {
            key: entry.key,
            title: this.sessionTitle(entry),
            model: entry.agentId || 'default',
            messageCount: 0, // placeholder — message count not on SessionEntry
            isActive: entry.key === activeKey,
        };
    }

    /**
     * Fetch owned sessions, filter out archived, map to cards.
     */
    private async getActiveSessionCards(
        folderUri: vscode.Uri
    ): Promise<SessionCard[]> {
        const state = this.getState(folderUri);
        const archived = new Set(state?.archivedKeys ?? []);
        const activeKey = state?.activeKey;

        const sessions = await this.sessionManager.getOwnedSessions();
        return sessions
            .filter((s) => !archived.has(s.key))
            .map((s) => this.toCard(s, activeKey));
    }

    // ── public API ──────────────────────────────────────────────────────

    /**
     * Smart reopen: if a session was active last time, resume it;
     * otherwise show the session list.
     */
    async handleInitRequest(
        webview: vscode.Webview,
        folderUri: vscode.Uri
    ): Promise<void> {
        try {
            const state = this.getState(folderUri);

            if (state?.activeKey) {
                // ── Resume last active session ──
                const history = await this.sessionManager.getSessionHistory(
                    50,
                    folderUri
                );
                webview.postMessage({
                    type: 'switchToChat',
                    key: state.activeKey,
                    title: state.activeKey,
                    history,
                });
            } else {
                // ── Show session picker ──
                const sessions = await this.getActiveSessionCards(folderUri);
                webview.postMessage({
                    type: 'switchToHome',
                    sessions,
                });
            }
        } catch (err) {
            this.logger.error('handleInitRequest failed', err);
            webview.postMessage({
                type: 'switchToHome',
                sessions: [],
            });
        }
    }

    /**
     * Resume a specific session: fetch history, activate, switch view.
     */
    async handleResume(
        webview: vscode.Webview,
        key: string,
        folderUri: vscode.Uri
    ): Promise<void> {
        try {
            // Verify ownership
            if (!this.sessionManager.isOwned(key)) {
                vscode.window.showWarningMessage(
                    `Session ${key} is not owned by this workspace.`
                );
                return;
            }

            const history = await this.sessionManager.getSessionHistory(
                50,
                folderUri
            );
            this.sessionManager.setActiveSession(folderUri, key);
            webview.postMessage({
                type: 'switchToChat',
                key,
                title: key,
                history,
            });
        } catch (err) {
            this.logger.error('handleResume failed', err);
            vscode.window.showErrorMessage(
                `Failed to resume session: ${err}`
            );
        }
    }

    /**
     * Archive a session (UI-level only — hide from list).
     * NEVER calls sessions.delete. Uses workspaceState.
     */
    async handleArchive(
        webview: vscode.Webview,
        key: string,
        folderUri: vscode.Uri
    ): Promise<void> {
        try {
            const state = this.getState(folderUri);
            if (!state) {
                this.logger.warn(
                    `No session state for folder ${folderUri.toString()}`
                );
                return;
            }

            // Add to archived set
            if (!state.archivedKeys) {
                state.archivedKeys = [];
            }
            if (!state.archivedKeys.includes(key)) {
                state.archivedKeys.push(key);
            }

            // If archiving the active session, clear activeKey
            if (state.activeKey === key) {
                state.activeKey =
                    state.chatKeys.length > 0
                        ? state.chatKeys[state.chatKeys.length - 1]
                        : state.rootKey;
            }

            folderSessions.saveSessionState(this.ctx, folderUri, state);

            // Push updated session list
            const sessions = await this.getActiveSessionCards(folderUri);
            webview.postMessage({ type: 'renderSessions', sessions });
        } catch (err) {
            this.logger.error('handleArchive failed', err);
        }
    }

    /**
     * Rename a session via sessions.patch.
     * Requires operator.admin scope.
     */
    async handleRename(
        webview: vscode.Webview,
        key: string,
        label: string,
        folderUri: vscode.Uri
    ): Promise<void> {
        try {
            // Scope check — sessions.patch needs operator.admin
            if (!this.gateway.authScopes.includes('operator.admin')) {
                vscode.window.showErrorMessage(
                    'Cannot rename session: missing operator.admin scope. ' +
                        'Check your gateway auth configuration.'
                );
                return;
            }

            await this.gateway.sendRequest('sessions.patch', { key, label });
            webview.postMessage({ type: 'updateTitle', key, title: label });
        } catch (err) {
            this.logger.error('handleRename failed', err);
            vscode.window.showErrorMessage(
                `Failed to rename session: ${err}`
            );
        }
    }

    /**
     * Create a new chat session, optionally send an initial message.
     */
    async handleCreateChat(
        webview: vscode.Webview,
        folderUri: vscode.Uri,
        text?: string
    ): Promise<void> {
        try {
            const key = await this.sessionManager.createNewChat(folderUri);
            this.sessionManager.setActiveSession(folderUri, key);

            if (text) {
                await this.sessionManager.sendChatMessage(text, {
                    workspaceFolder: folderUri.fsPath,
                });
            }

            webview.postMessage({
                type: 'switchToChat',
                key,
                title: 'New chat',
                history: [],
            });
        } catch (err) {
            this.logger.error('handleCreateChat failed', err);
            vscode.window.showErrorMessage(
                `Failed to create chat: ${err}`
            );
        }
    }

    /**
     * Return to the session list view.
     */
    async handleBackToSessions(
        webview: vscode.Webview,
        folderUri: vscode.Uri
    ): Promise<void> {
        try {
            this.sessionManager.clearSession(folderUri);
            const sessions = await this.getActiveSessionCards(folderUri);
            webview.postMessage({ type: 'switchToHome', sessions });
        } catch (err) {
            this.logger.error('handleBackToSessions failed', err);
        }
    }

    /**
     * Open VS Code settings (scoped to OpenClaw).
     */
    handleOpenSettings(_webview: vscode.Webview): void {
        vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'openclaw'
        );
    }
}
