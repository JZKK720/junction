import * as vscode from 'vscode';
import { ChatBase } from './chatBase';
import { BridgeRegistry } from '../bridges/registry';

// Disabled legacy editor-column chat surface. Not registered by default; the
// sidebar webview is the only default chat/session UI.

export class ChatPanel extends ChatBase {
    private panel: vscode.WebviewPanel | undefined;

    constructor(
        extensionUri: vscode.Uri,
        bridgeRegistry: BridgeRegistry
    ) {
        super(extensionUri, bridgeRegistry);
    }

    protected postToWebview(message: any): void {
        this.panel?.webview.postMessage(message);
    }

    public show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'junctionChat',
            'Junction',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    this.extensionUri,
                    vscode.Uri.joinPath(this.extensionUri, 'node_modules')
                ]
            }
        );

        this.panel.webview.html = this.buildHtml(this.panel.webview);
        this.wireMessageHandler(this.panel.webview);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }
}
