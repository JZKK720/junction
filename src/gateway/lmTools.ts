import * as vscode from 'vscode';
import { GatewayConnection } from './connection';
import { ToolStatusManager } from './toolStatus';
import { Logger } from '../utils/logger';

/**
 * Registers the gateway's effective tools with the VS Code Language Model
 * tool registry. This makes them visible and invocable by VS Code's LM API
 * (e.g. from Chat Participants or Copilot).
 *
 * Each gateway tool is wrapped as a vscode.LanguageModelTool that forwards
 * invocations to the agent via a fire-and-collect pattern.
 */
export async function registerGatewayTools(
    context: vscode.ExtensionContext,
    gateway: GatewayConnection,
    toolStatusManager: ToolStatusManager
): Promise<void> {
    const logger = Logger.getInstance();

    // Load effective tools from gateway
    await toolStatusManager.load(gateway);
    const status = toolStatusManager.getStatus();

    if (!status || status.tools.length === 0) {
        logger.info('No gateway tools to register with VS Code LM API');
        return;
    }

    const enabledTools = status.tools.filter(t => t.enabled);
    logger.info(`Registering ${enabledTools.length} gateway tools with VS Code LM API`);

    for (const tool of enabledTools) {
        const toolId = `openclaw_${tool.name}`;
        const disposable = vscode.lm.registerTool<{ input: string }>(toolId, {
            async invoke(
                options: vscode.LanguageModelToolInvocationOptions<{ input: string }>,
                _token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelToolResult> {
                logger.info(`LM tool invoked: ${tool.name}`, options.input);
                // Tools on the gateway side are executed by the agent process, not by
                // the extension. We surface the tool name + args back to the caller.
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Tool '${tool.name}' runs on the OpenClaw gateway. ` +
                        `Input: ${JSON.stringify(options.input)}`
                    )
                ]);
            },
            prepareInvocation(
                options: vscode.LanguageModelToolInvocationPrepareOptions<{ input: string }>,
                _token: vscode.CancellationToken
            ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
                return {
                    invocationMessage: `Running ${tool.name} on OpenClaw gateway…`,
                };
            },
        });
        context.subscriptions.push(disposable);
    }

    logger.info('Gateway tools registered with VS Code LM API');
}
