import * as vscode from 'vscode';

export async function openJunctionSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'junction');
}
