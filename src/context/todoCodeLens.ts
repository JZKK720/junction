import * as vscode from 'vscode';
import { config } from '../config/agentBridgeConfig';
import { ChatViewProvider } from '../ui/chatViewProvider';
import { t } from '../l10n';

const TODO_RE = /\b(TODO|FIXME|HACK)\b[:\-\s]?(.*)$/i;

export function registerTodoCodeLensProvider(
    context: vscode.ExtensionContext,
    getChatViewProvider: () => ChatViewProvider | undefined,
): void {
    const provider = new TodoCodeLensProvider(getChatViewProvider);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
    );
}

class TodoCodeLensProvider implements vscode.CodeLensProvider {
    constructor(private readonly getChatViewProvider: () => ChatViewProvider | undefined) {}

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!config().get<boolean>('todoCodeLensEnabled', false)) return [];
        const lenses: vscode.CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            const match = text.match(TODO_RE);
            if (!match) continue;
            const range = new vscode.Range(line, 0, line, text.length);
            lenses.push(new vscode.CodeLens(range, {
                title: t('Implement with Junction'),
                command: 'junction.todoCodeLens.send',
                arguments: [document.uri, line, match[0]],
            }));
        }
        return lenses;
    }
}

export function registerTodoCodeLensCommand(context: vscode.ExtensionContext, getChatViewProvider: () => ChatViewProvider | undefined): void {
    context.subscriptions.push(vscode.commands.registerCommand(
        'junction.todoCodeLens.send',
        async (uri: vscode.Uri, line: number, text: string) => {
            const provider = getChatViewProvider();
            if (!provider) return;
            provider.addFilePill(uri);
            await provider.sendText(`Implement this code comment:\n${vscode.workspace.asRelativePath(uri)}:${line + 1}\n${text}`);
            await vscode.commands.executeCommand('workbench.view.extension.junction-explorer');
        },
    ));
}
