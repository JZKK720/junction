import * as vscode from 'vscode';
import { GatewayConnection } from '../gateway/connection';
import { SessionManager } from '../gateway/sessionManager';
import { Logger } from '../utils/logger';
import { buildAgentParams } from '../gateway/agentConfig';

/**
 * Disabled legacy native chat integration.
 * Not registered by default; kept only for a future opt-in native surface.
 */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    gateway: GatewayConnection,
    sessionManager: SessionManager
): void {
    const logger = Logger.getInstance();

    const participant = vscode.chat.createChatParticipant(
        'openclaw.agent',
        async (
            request: vscode.ChatRequest,
            chatContext: vscode.ChatContext,
            response: vscode.ChatResponseStream,
            token: vscode.CancellationToken
        ) => {
            if (!gateway.isConnected()) {
                response.markdown('**OpenClaw gateway is not connected.** Check the status bar and your `openclaw.gatewayUrl` setting.');
                return;
            }

            const prompt = request.prompt.trim();
            if (!prompt) {
                response.markdown('Hi! I\'m OpenClaw. Ask me anything about your codebase.');
                return;
            }

            // Progress indicator while we establish the session
            response.progress('Connecting to OpenClaw gateway…');

            let sessionKey: string;
            try {
                sessionKey = await sessionManager.ensureSession();
            } catch (err) {
                response.markdown(`**Failed to establish session:** ${String(err)}`);
                return;
            }

            // Build the context string from VS Code's active editor
            const editor = vscode.window.activeTextEditor;
            const workspace = vscode.workspace.workspaceFolders?.[0];
            const contextParts: string[] = [];
            if (workspace) { contextParts.push(`Workspace: ${workspace.uri.fsPath}`); }
            if (editor) { contextParts.push(`Active file: ${editor.document.fileName}`); }
            const contextHeader = contextParts.length ? contextParts.join(' | ') + '\n\n' : '';

            const fullPrompt = contextHeader + prompt;
            const agentParams = buildAgentParams(sessionKey, fullPrompt, {
                model: request.model?.id?.replace(/^openclaw\//, ''),
            });

            // Set verboseLevel so tool events stream back
            gateway.sendRequest('sessions.patch', { key: sessionKey, verboseLevel: 'on' }).catch(() => {});

            response.progress('Asking OpenClaw…');

            return new Promise<void>((resolve) => {
                if (token.isCancellationRequested) { resolve(); return; }

                const onEvent = (event: any) => {
                    if (token.isCancellationRequested) {
                        gateway.off('processed_event', onEvent);
                        resolve();
                        return;
                    }

                    if (event.type === 'agent_message' && event.delta) {
                        response.markdown(event.delta);
                    }

                    if (event.type === 'tool_event' && event.phase === 'start') {
                        response.progress(`Running tool: ${event.toolName}`);
                    }

                    if (event.type === 'agent_lifecycle' && ['completed', 'error', 'cancelled'].includes(event.phase)) {
                        gateway.off('processed_event', onEvent);
                        if (event.usage) {
                            response.markdown(
                                `\n\n---\n*↑ ${(event.usage.inputTokens || 0).toLocaleString()} tokens in · ↓ ${(event.usage.outputTokens || 0).toLocaleString()} tokens out*`
                            );
                        }
                        resolve();
                    }
                };

                gateway.on('processed_event', onEvent);

                token.onCancellationRequested(() => {
                    gateway.off('processed_event', onEvent);
                    resolve();
                });

                gateway.sendRequest('agent', agentParams, { idleTimeoutMs: 30000 })
                    .catch((err) => {
                        gateway.off('processed_event', onEvent);
                        response.markdown(`**Error:** ${String(err)}`);
                        resolve();
                    });
            });
        }
    );

    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');

    participant.followupProvider = {
        provideFollowups(
            _result: vscode.ChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken
        ): vscode.ProviderResult<vscode.ChatFollowup[]> {
            return [
                { prompt: 'Explain what you just did', label: 'Explain', command: '' },
                { prompt: 'What should I do next?', label: 'Next steps', command: '' },
            ];
        }
    };

    context.subscriptions.push(participant);
    logger.info('Chat Participant registered (@openclaw.agent)');
}
