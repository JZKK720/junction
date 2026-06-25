import * as vscode from 'vscode';
import { GatewayConnection } from '../../gateway/connection';
import { getOwnedSessions } from '../../gateway/folderSessions';
import { bindingIdForUri, ChatIndex } from '../../gateway/chatIndex';
import { BridgeSession, ChatScope } from '../types';

type OpenClawSessionManager = {
    getCurrentSessionKey(folderUri?: vscode.Uri): string | null;
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri>;
};

export async function listOpenClawWorkspaceSessions(options: {
    gateway: GatewayConnection;
    sessionManager: OpenClawSessionManager;
    chatIndex: ChatIndex;
    scope: ChatScope;
    includeArchived: boolean;
    archivedKeys: ReadonlySet<string>;
    onRawSessions?: (sessions: Array<{ key: string; label?: string }>) => void;
}): Promise<BridgeSession[]> {
    const { gateway, sessionManager, chatIndex, scope, includeArchived, archivedKeys, onRawSessions } = options;
    if (!gateway.capabilities.canListSessions()) return [];
    const activeKey = sessionManager.getCurrentSessionKey() ?? undefined;
    const binding = sessionManager.getSessionToFolder();
    let raw: Array<{ key: string; label?: string; updatedAt?: number; lastActiveAt?: number; createdAt?: number }>;
    if (scope === 'all') {
        const res = await gateway.sendRequest('sessions.list', {});
        raw = Array.isArray(res?.sessions) ? res.sessions : [];
    } else {
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        raw = await getOwnedSessions(gateway);
        if (currentFolder) {
            raw = raw.filter((s) => binding.get(s.key)?.toString() === currentFolder.toString());
        }
    }
    if (scope === 'all') chatIndex.prune(new Set(raw.map((s) => s.key)));
    onRawSessions?.(raw);
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return raw
        .filter((s) => includeArchived || !archivedKeys.has(s.key))
        .map((s) => {
            const folderUri = binding.get(s.key);
            const bindingId = folderUri ? bindingIdForUri(folderUri) : 'agent';
            const bindingLabel = folderUri ? folderUri.path.split('/').pop() || 'Chat' : 'Agent';
            const isCurrentGroup = !!folderUri && !!currentFolder
                && folderUri.toString() === currentFolder.toString();
            const ts = s.updatedAt ?? s.lastActiveAt ?? s.createdAt;
            chatIndex.upsert({
                sessionKey: s.key,
                bindingId,
                bindingLabel,
                summary: s.label || s.key,
                model: scope === 'all' ? bindingLabel : undefined,
            });
            return {
                key: s.key,
                title: s.label || s.key.split(':').pop() || 'Untitled',
                model: scope === 'all' ? bindingLabel : undefined,
                isActive: s.key === activeKey,
                isArchived: archivedKeys.has(s.key),
                groupId: bindingId,
                groupLabel: isCurrentGroup ? 'This folder' : bindingLabel,
                isCurrentGroup,
                lastActiveTs: typeof ts === 'number' ? ts : undefined,
            };
        });
}
