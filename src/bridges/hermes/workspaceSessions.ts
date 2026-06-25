import * as vscode from 'vscode';
import { bindSessionWorkspace, boundWorkspaceUri, decorateSessionsWithWorkspaceBindings } from '../sessionBindings';
import { BridgeSession, ChatScope } from '../types';

export function bindHermesSessionWorkspace(
    context: vscode.ExtensionContext,
    sessionKey: string | null | undefined,
    folderUri?: vscode.Uri,
): void {
    bindSessionWorkspace(context, 'hermes', sessionKey, folderUri);
}

export function boundHermesSessionWorkspace(
    context: vscode.ExtensionContext,
    sessionKey: string | null | undefined,
): vscode.Uri | undefined {
    return boundWorkspaceUri(context, 'hermes', sessionKey);
}

export function decorateHermesWorkspaceSessions(options: {
    context: vscode.ExtensionContext;
    sessions: BridgeSession[];
    scope: ChatScope;
    currentFolder?: vscode.Uri;
}): BridgeSession[] {
    return decorateSessionsWithWorkspaceBindings(
        options.context,
        'hermes',
        options.sessions,
        options.scope,
        options.currentFolder,
        false,
        hermesNativeWorkspaceBinding,
    );
}

export function hermesNativeWorkspaceBinding(session: BridgeSession): { workspaceUri: string; workspaceName: string } | undefined {
    const raw = String(session.workspaceUri || '').trim();
    if (!raw) return undefined;
    const uri = raw.includes(':') ? raw : vscode.Uri.file(raw).toString();
    let parsed: vscode.Uri;
    try {
        parsed = vscode.Uri.parse(uri);
    } catch {
        return undefined;
    }
    const name = session.workspaceName
        || vscode.workspace.getWorkspaceFolder(parsed)?.name
        || parsed.fsPath.split(/[\\/]/).filter(Boolean).pop()
        || parsed.path.split('/').filter(Boolean).pop()
        || parsed.toString();
    return { workspaceUri: parsed.toString(), workspaceName: name };
}
