import * as vscode from 'vscode';
import { jsonRequest } from '../http';
import { bindSessionWorkspace, boundWorkspaceUri, decorateSessionsWithWorkspaceBindings } from '../sessionBindings';
import { BridgeSession, ChatScope } from '../types';

export type KnownMiMoCodeSession = { title: string; model?: string; workspaceUri?: string; workspaceName?: string };

export function workspaceDirectory(folderUri?: vscode.Uri): string {
    return folderUri?.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

export function withDirectory(baseUrl: string, endpoint: string, folderUri?: vscode.Uri): string {
    const url = new URL(endpoint, baseUrl.replace(/\/$/, '') + '/');
    const dir = workspaceDirectory(folderUri);
    if (dir) url.searchParams.set('directory', dir);
    return url.toString();
}

export function bindMiMoCodeSessionWorkspace(
    context: vscode.ExtensionContext,
    bridgeId: string,
    sessionKey: string | null | undefined,
    folderUri?: vscode.Uri,
): void {
    bindSessionWorkspace(context, bridgeId, sessionKey, folderUri);
}

export function boundMiMoCodeSessionWorkspace(
    context: vscode.ExtensionContext,
    bridgeId: string,
    sessionKey: string | null | undefined,
): vscode.Uri | undefined {
    return boundWorkspaceUri(context, bridgeId, sessionKey);
}

export function miMoCodeNativeWorkspaceBinding(session: BridgeSession): { workspaceUri: string; workspaceName: string } | undefined {
    const raw = String(session.workspaceUri || '').trim();
    if (!raw) return undefined;
    const parsed = raw.includes(':') ? vscode.Uri.parse(raw) : vscode.Uri.file(raw);
    const name = session.workspaceName
        || vscode.workspace.getWorkspaceFolder(parsed)?.name
        || parsed.fsPath.split(/[\\/]/).filter(Boolean).pop()
        || parsed.path.split('/').filter(Boolean).pop()
        || parsed.toString();
    return { workspaceUri: parsed.toString(), workspaceName: name };
}

export function decorateMiMoCodeSessions(options: {
    context: vscode.ExtensionContext;
    bridgeId: string;
    sessions: BridgeSession[];
    scope: ChatScope;
    currentFolder?: vscode.Uri;
}): BridgeSession[] {
    return decorateSessionsWithWorkspaceBindings(
        options.context,
        options.bridgeId,
        options.sessions,
        options.scope,
        options.currentFolder,
        false,
        miMoCodeNativeWorkspaceBinding,
    );
}

export function normalizeMiMoCodeSession(
    row: any,
    bridgeId: string,
    activeSessionId: string | null,
    archivedKeys: ReadonlySet<string>,
    known?: KnownMiMoCodeSession,
): BridgeSession | null {
    const key = String(row?.id ?? row?.sessionID ?? '');
    if (!key) return null;
    const title = String(row?.title || known?.title || row?.slug || key);
    const model = typeof row?.model === 'string'
        ? row.model
        : (row?.model?.providerID && row?.model?.id ? `${row.model.providerID}/${row.model.id}` : known?.model);
    const directory = typeof row?.directory === 'string'
        ? row.directory
        : (typeof row?.path === 'string' ? row.path : known?.workspaceUri);
    const updated = row?.time?.updated ?? row?.time?.created ?? row?.updatedAt ?? row?.createdAt;
    return {
        key,
        title,
        model,
        isActive: key === activeSessionId,
        isArchived: archivedKeys.has(key) || !!row?.time?.archived,
        groupId: bridgeId,
        groupLabel: bridgeId,
        workspaceUri: directory || undefined,
        workspaceName: known?.workspaceName,
        lastActiveTs: typeof updated === 'number' ? updated : undefined,
    };
}

export async function listMiMoCodeSessions(options: {
    baseUrl: string;
    bridgeId: string;
    activeSessionId: string | null;
    includeArchived: boolean;
    archivedKeys: ReadonlySet<string>;
    knownSessions: Map<string, KnownMiMoCodeSession>;
    folderUri?: vscode.Uri;
}): Promise<BridgeSession[]> {
    const raw: any[] = await jsonRequest(
        withDirectory(options.baseUrl, 'session', options.folderUri),
        { timeoutMs: 4000 },
    ) || [];
    const sessions: BridgeSession[] = [];
    for (const row of raw) {
        const session = normalizeMiMoCodeSession(
            row,
            options.bridgeId,
            options.activeSessionId,
            options.archivedKeys,
            options.knownSessions.get(String(row?.id ?? '')),
        );
        if (!session) continue;
        if (!options.includeArchived && session.isArchived) continue;
        sessions.push(session);
        options.knownSessions.set(session.key, {
            title: session.title,
            model: session.model,
            workspaceUri: session.workspaceUri,
            workspaceName: session.workspaceName,
        });
    }
    return sessions;
}
