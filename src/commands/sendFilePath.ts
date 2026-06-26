import * as vscode from 'vscode';
import { BridgeRegistry } from '../bridges/registry';
import { t } from '../l10n';

export function registerSendFilePathCommand(
    context: vscode.ExtensionContext,
    bridgeRegistry: BridgeRegistry,
    chatViewProvider?: { addStagedPill: (pill: any) => void }
): void {
    const handler = async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage(t('No active file'));
            return;
        }

        const filePath = editor.document.fileName;
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        // Create a pill so the user can see and remove the staged context
        const relativePath = vscode.workspace.asRelativePath(filePath);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const displayText = selection.isEmpty
            ? relativePath
            : `${relativePath}:${startLine}${endLine !== startLine ? '-' + endLine : ''}`;

        chatViewProvider?.addStagedPill({
            filePath: relativePath,
            displayText,
            isLive: false,
            startLine: startLine,
            endLine: endLine,
            language: editor.document.languageId,
            selectedText: selectedText || undefined,
        });
        vscode.window.showInformationMessage(t('File context staged for next message'));
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('junction.sendFilePath', handler),
        vscode.commands.registerCommand('openclaw.sendFilePath', handler),
    );
}
