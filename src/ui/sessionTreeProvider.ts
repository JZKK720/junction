import * as vscode from 'vscode';
import { GatewayConnection } from '../gateway/connection';
import { SessionManager } from '../gateway/sessionManager';
import { Logger } from '../utils/logger';
import {
    getSessionState,
    newChat,
    deleteSession,
    resetSession,
    FolderSessionState,
} from '../gateway/folderSessions';

// Disabled legacy Sessions tree. Not registered by default; session home now
// lives inside the OpenClaw sidebar webview.

// ─────────────────────────────────────────────────────────────────────────────
// Gateway node — always at the top of the tree
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayNode extends vscode.TreeItem {
    constructor(connected: boolean, url: string) {
        const label = connected ? url : `${url} (disconnected)`;
        super(label, vscode.TreeItemCollapsibleState.None);

        this.contextValue = connected ? 'openclawGatewayConnected' : 'openclawGatewayDisconnected';
        this.iconPath = new vscode.ThemeIcon(
            connected ? 'plug' : 'debug-disconnect',
            connected
                ? new vscode.ThemeColor('testing.iconPassed')
                : new vscode.ThemeColor('testing.iconFailed'),
        );
        this.tooltip = connected
            ? `Connected to ${url}\nClick to change gateway`
            : `Disconnected from ${url}\nClick to reconnect or change gateway`;
        this.description = connected ? 'connected' : 'disconnected';

        this.command = {
            command: 'openclaw.configureGateway',
            title: 'Configure Gateway',
            arguments: [],
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session node
// ─────────────────────────────────────────────────────────────────────────────

export type SessionNodeKind = 'folder' | 'session';

export class SessionNode extends vscode.TreeItem {
    constructor(
        public readonly kind: SessionNodeKind,
        label: string,
        public readonly folderUri: vscode.Uri,
        public readonly sessionKey: string | null,
        collapsible: vscode.TreeItemCollapsibleState,
        public readonly isActive: boolean,
        public readonly isRunning: boolean,
    ) {
        super(label, collapsible);

        if (kind === 'folder') {
            this.contextValue = 'openclawFolder';
            this.iconPath = new vscode.ThemeIcon('folder');
        } else {
            this.contextValue = isActive ? 'openclawSessionActive' : 'openclawSession';
            this.iconPath = isRunning
                ? new vscode.ThemeIcon('sync~spin')
                : isActive
                    ? new vscode.ThemeIcon('comment-discussion')
                    : new vscode.ThemeIcon('comment');

            this.description = isRunning ? 'running' : isActive ? 'active' : undefined;

            this.command = {
                command: 'openclaw.switchSession',
                title: 'Switch to session',
                arguments: [this],
            };
        }

        this.tooltip = sessionKey ?? label;
    }
}

type TreeNode = GatewayNode | SessionNode;

// ─────────────────────────────────────────────────────────────────────────────
// Tree provider
// ─────────────────────────────────────────────────────────────────────────────

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private runningKeys = new Set<string>();
    private connected = false;
    private logger = Logger.getInstance();

    constructor(
        private readonly gateway: GatewayConnection,
        private readonly sessionManager: SessionManager,
    ) {
        gateway.on('connected', () => { this.connected = true; this.refresh(); });
        gateway.on('disconnected', () => { this.connected = false; this.refresh(); });
        gateway.on('sessions.changed', () => this.refresh());

        gateway.on('processed_event', (event: any) => {
            if (event.type === 'agent_lifecycle') {
                const key = event.sessionKey;
                if (!key) return;
                if (event.phase === 'start') {
                    this.runningKeys.add(key);
                } else if (['completed', 'error', 'cancelled'].includes(event.phase)) {
                    this.runningKeys.delete(key);
                }
                this._onDidChangeTreeData.fire();
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
        // Root level: gateway node + one node per workspace folder
        if (!element) {
            const url = vscode.workspace
                .getConfiguration('openclaw')
                .get<string>('gatewayUrl', 'ws://127.0.0.1:18789');
            const nodes: TreeNode[] = [new GatewayNode(this.connected, url)];
            const folders = vscode.workspace.workspaceFolders;
            if (folders) {
                for (const wf of folders) {
                    nodes.push(new SessionNode(
                        'folder', wf.name, wf.uri, null,
                        vscode.TreeItemCollapsibleState.Expanded, false, false,
                    ));
                }
            }
            return nodes;
        }

        // Folder level: root session + child chats
        if (element instanceof SessionNode && element.kind === 'folder') {
            return this.getSessionNodes(element.folderUri);
        }

        return [];
    }

    private getSessionNodes(folderUri: vscode.Uri): SessionNode[] {
        const ctx = this.sessionManager.context;
        const state: FolderSessionState | undefined = getSessionState(ctx, folderUri);
        if (!state) return [];

        const activeKey = this.sessionManager.getCurrentSessionKey(folderUri) ?? state.activeKey;
        const nodes: SessionNode[] = [];

        nodes.push(this.makeSessionNode('Root', state.rootKey, folderUri, activeKey));

        for (const key of [...state.chatKeys].reverse()) {
            const idx = state.chatKeys.indexOf(key);
            const label = idx >= 0 ? `Chat ${idx + 1}` : key.slice(-8);
            nodes.push(this.makeSessionNode(label, key, folderUri, activeKey));
        }

        return nodes;
    }

    private makeSessionNode(
        label: string, key: string, folderUri: vscode.Uri, activeKey: string,
    ): SessionNode {
        return new SessionNode(
            'session', label, folderUri, key,
            vscode.TreeItemCollapsibleState.None,
            key === activeKey,
            this.runningKeys.has(key),
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command registrations
// ─────────────────────────────────────────────────────────────────────────────

export function registerSessionTreeCommands(
    context: vscode.ExtensionContext,
    gateway: GatewayConnection,
    sessionManager: SessionManager,
    treeProvider: SessionTreeProvider,
    onSessionSwitch: (folderUri: vscode.Uri, key: string) => void,
): void {
    const logger = Logger.getInstance();

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.switchSession', (node: SessionNode) => {
            if (!node.sessionKey) return;
            sessionManager.setActiveSession(node.folderUri, node.sessionKey);
            treeProvider.refresh();
            onSessionSwitch(node.folderUri, node.sessionKey);
            logger.info(`Switched to session: ${node.sessionKey}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.newChat', async (node?: SessionNode) => {
            const folderUri = node?.folderUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!folderUri) { vscode.window.showWarningMessage('No workspace folder open'); return; }
            try {
                const key = await newChat(gateway, sessionManager.context, folderUri);
                sessionManager.setActiveSession(folderUri, key);
                treeProvider.refresh();
                onSessionSwitch(folderUri, key);
            } catch (err) {
                vscode.window.showErrorMessage('Failed to create chat: ' + String(err));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.reconnectGateway', async () => {
            try {
                gateway.disconnect();
                await gateway.connect();
                await sessionManager.initializeFolderSessions();
                treeProvider.refresh();
                vscode.window.showInformationMessage('Reconnected to OpenClaw gateway.');
            } catch (err) {
                vscode.window.showErrorMessage('Reconnect failed: ' + String(err));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.resetSession', async (node: SessionNode) => {
            if (!node.sessionKey) return;
            const confirm = await vscode.window.showWarningMessage(
                `Reset session "${node.label}"? This clears its message history.`,
                { modal: true }, 'Reset'
            );
            if (confirm !== 'Reset') return;
            try {
                await resetSession(gateway, node.sessionKey);
                treeProvider.refresh();
                vscode.window.showInformationMessage('Session reset.');
            } catch (err) {
                vscode.window.showErrorMessage('Reset failed: ' + String(err));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.deleteSession', async (node: SessionNode) => {
            if (!node.sessionKey) return;
            const confirm = await vscode.window.showWarningMessage(
                `Delete session "${node.label}"? This cannot be undone.`,
                { modal: true }, 'Delete'
            );
            if (confirm !== 'Delete') return;
            try {
                await deleteSession(gateway, node.sessionKey);
                treeProvider.refresh();
                vscode.window.showInformationMessage('Session deleted.');
            } catch (err) {
                vscode.window.showErrorMessage('Delete failed: ' + String(err));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.copySessionKey', (node: SessionNode) => {
            if (!node.sessionKey) return;
            vscode.env.clipboard.writeText(node.sessionKey);
            vscode.window.showInformationMessage(`Copied: ${node.sessionKey}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.refreshSessions', () => treeProvider.refresh())
    );
}
