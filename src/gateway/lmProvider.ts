import * as vscode from 'vscode';
import { GatewayConnection } from './connection';
import { ModelManager } from './modelManager';
import { Logger } from '../utils/logger';

/**
 * Disabled legacy VS Code language-model integration.
 * Not registered by default; kept only for a future opt-in native surface.
 */
export function registerLanguageModelProvider(
    context: vscode.ExtensionContext,
    gateway: GatewayConnection,
    modelManager: ModelManager
): void {
    const logger = Logger.getInstance();

    // Runtime registration only; package contribution is intentionally absent.
    const lm = vscode.lm as any;
    const disposable = lm.registerChatModelProvider(
        'openclaw',
        {
            async provideLanguageModelChatInformation(
                _options: vscode.PrepareLanguageModelChatModelOptions,
                _token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelChatInformation[]> {
                try {
                    const providers = await modelManager.getModels(gateway);
                    const models: vscode.LanguageModelChatInformation[] = [];

                    for (const group of providers) {
                        for (const model of group.models) {
                            const entry = typeof model === 'object' ? model : { id: String(model), name: String(model) };
                            models.push({
                                id: `openclaw/${entry.id}`,
                                name: entry.name || entry.id,
                                family: group.provider,
                                version: '1',
                                maxInputTokens: 200000,
                                maxOutputTokens: 16000,
                                capabilities: {
                                    agentMode: false,
                                    toolCalling: !!entry.capabilities?.tools,
                                    vision: !!entry.capabilities?.vision,
                                } as any,
                            });
                        }
                    }

                    logger.info(`Registered ${models.length} models with VS Code LM API`);
                    return models;
                } catch (err) {
                    logger.warn('Failed to load models for LM provider', err);
                    return [];
                }
            },

            async provideLanguageModelChatResponse(
                model: vscode.LanguageModelChatInformation,
                messages: readonly vscode.LanguageModelChatRequestMessage[],
                _options: vscode.ProvideLanguageModelChatResponseOptions,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken
            ): Promise<void> {
                // Extract model id after "openclaw/"
                const modelId = model.id.replace(/^openclaw\//, '');

                // Convert VS Code messages to a single prompt string
                const prompt = messages
                    .map(m => {
                        const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'User' : 'Assistant';
                        const text = m.content
                            .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                            .map(p => p.value)
                            .join('');
                        return `${role}: ${text}`;
                    })
                    .join('\n');

                return new Promise<void>((resolve, reject) => {
                    if (token.isCancellationRequested) { resolve(); return; }

                    const onData = (event: any) => {
                        if (token.isCancellationRequested) { resolve(); return; }
                        if (event.type === 'agent_message' && event.delta) {
                            progress.report(new vscode.LanguageModelTextPart(event.delta));
                        }
                        if (event.type === 'agent_lifecycle' && ['completed', 'error', 'cancelled'].includes(event.phase)) {
                            gateway.off('processed_event', onData);
                            resolve();
                        }
                    };

                    gateway.on('processed_event', onData);
                    token.onCancellationRequested(() => {
                        gateway.off('processed_event', onData);
                        resolve();
                    });

                    gateway.sendRequest(
                        'agent',
                        {
                            message: prompt,
                            model: modelId,
                            provider: model.family,
                            idempotencyKey: `lm-${Date.now()}`,
                        },
                        { idleTimeoutMs: 30000 }
                    ).catch((err) => {
                        gateway.off('processed_event', onData);
                        reject(err);
                    });
                });
            },

            async provideTokenCount(
                _model: vscode.LanguageModelChatInformation,
                text: string | vscode.LanguageModelChatRequestMessage,
                _token: vscode.CancellationToken
            ): Promise<number> {
                const str = typeof text === 'string' ? text : '';
                // Approximate: 4 chars per token
                return Math.ceil(str.length / 4);
            },
        },
        { isDefault: false }
    );

    context.subscriptions.push(disposable);
    logger.info('Language Model Provider registered (vendor: openclaw)');
}
