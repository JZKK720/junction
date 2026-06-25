import * as vscode from 'vscode';
import { BridgeSession, ChatScope } from './types';

interface StoredBinding {
    sessionKey: string;
    workspaceUri: string;
    workspaceName: string;
    updatedAt: number;
}

interface WorkspaceBindingInfo {
    workspaceUri: string;
    workspaceName: string;
}

function storageKey(bridgeId: string): string {
    return `junction.${bridgeId}.sessionWorkspaceBindings`;
}

function readBindings(context: vscode.ExtensionContext, bridgeId: string): StoredBinding[] {
    return context.workspaceState.get<StoredBinding[]>(storageKey(bridgeId), []) || [];
}

function writeBindings(context: vscode.ExtensionContext, bridgeId: string, bindings: StoredBinding[]): void {
    void context.workspaceState.update(storageKey(bridgeId), bindings.slice(-1000));
}

function workspaceId(uri: vscode.Uri | undefined): string {
    return uri?.toString() || '';
}

export function bindSessionWorkspace(context: vscode.ExtensionContext, bridgeId: string, sessionKey: string | null | undefined, folderUri?: vscode.Uri): void {
    const key = String(sessionKey || '').trim();
    if (!key || !folderUri) return;
    const uri = workspaceId(folderUri);
    if (!uri) return;
    const bindings = readBindings(context, bridgeId).filter((item) => item.sessionKey !== key);
    bindings.push({
        sessionKey: key,
        workspaceUri: uri,
        workspaceName: vscode.workspace.getWorkspaceFolder(folderUri)?.name || folderUri.fsPath.split(/[\\/]/).pop() || folderUri.fsPath,
        updatedAt: Date.now(),
    });
    writeBindings(context, bridgeId, bindings);
}

export function boundWorkspaceUri(context: vscode.ExtensionContext, bridgeId: string, sessionKey: string | null | undefined): vscode.Uri | undefined {
    const key = String(sessionKey || '').trim();
    if (!key) return undefined;
    const found = readBindings(context, bridgeId).find((item) => item.sessionKey === key);
    if (!found?.workspaceUri) return undefined;
    try { return vscode.Uri.parse(found.workspaceUri); } catch { return undefined; }
}

export function decorateSessionsWithWorkspaceBindings(
    context: vscode.ExtensionContext,
    bridgeId: string,
    sessions: BridgeSession[],
    scope: ChatScope,
    currentFolder?: vscode.Uri,
    nativeWorkspaceAware = false,
    nativeWorkspaceBinding?: (session: BridgeSession) => WorkspaceBindingInfo | undefined,
): BridgeSession[] {
    if (nativeWorkspaceAware) return sessions;
    const current = workspaceId(currentFolder);
    const bindings = new Map(readBindings(context, bridgeId).map((item) => [item.sessionKey, item]));
    const decorated: BridgeSession[] = [];
    for (const session of sessions) {
        const stored = bindings.get(session.key);
        const native = nativeWorkspaceBinding?.(session);
        const binding = stored || native;
        const isCurrentGroup = !!binding && !!current && binding.workspaceUri === current;
        if (scope === 'folder' && !isCurrentGroup) continue;
        decorated.push({
            ...session,
            groupId: binding?.workspaceUri || session.groupId || 'recent',
            groupLabel: binding?.workspaceName || session.groupLabel || 'Recent',
            isCurrentGroup: isCurrentGroup || (!binding && !!session.isCurrentGroup),
        });
    }
    return scope === 'folder' ? decorated : decorated;
}
