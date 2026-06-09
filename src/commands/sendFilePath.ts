import * as vscode from 'vscode';
import { BridgeRegistry } from '../bridges/registry';

export function registerSendFilePathCommand(
    context: vscode.ExtensionContext,
    bridgeRegistry: BridgeRegistry
): void {
    const handler = async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('No active file');
            return;
        }

        const filePath = editor.document.fileName;
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        let message = `Current file: ${filePath}`;

        if (selectedText) {
            message += `\n\nSelected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``;
        }

        bridgeRegistry.active.setPendingFileContext(message);
        vscode.window.showInformationMessage('File context staged for next message');
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('junction.sendFilePath', handler),
        vscode.commands.registerCommand('openclaw.sendFilePath', handler),
    );
}
