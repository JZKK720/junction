import { BridgeContext, VSCODE_WORKSPACE_CONTEXT_PREFIX } from './types';

export function buildHiddenWorkspaceContext(context: BridgeContext): string {
    const workspace = String(context.workspaceFolder ?? context.workspace ?? '').trim();
    if (!workspace) return '';
    return [
        VSCODE_WORKSPACE_CONTEXT_PREFIX,
        `workspace: ${workspace}`,
        'treat paths as relative to workspace.',
    ].join('\n');
}

export function hiddenContextKey(sessionKey: string, context: BridgeContext): string {
    const workspace = String(context.workspaceFolder ?? context.workspace ?? '').trim();
    return `${sessionKey}::${workspace}`;
}
