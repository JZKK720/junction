import * as vscode from 'vscode';
import { ChatBase } from './chatBase';
import { BridgeRegistry } from '../bridges/registry';

export class ChatViewProvider extends ChatBase implements vscode.WebviewViewProvider {
    public static readonly viewType = 'junction.chatView';
    private _view?: vscode.WebviewView;

    constructor(
        extensionUri: vscode.Uri,
        bridgeRegistry: BridgeRegistry
    ) {
        super(extensionUri, bridgeRegistry);
    }

    protected postToWebview(message: any): void {
        this._view?.webview.postMessage(message);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.extensionUri,
                vscode.Uri.joinPath(this.extensionUri, 'node_modules')
            ]
        };

        webviewView.webview.html = this.buildHtml(webviewView.webview);
        this.wireMessageHandler(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this.repaintTranscript(); }
        });
    }

    /** Called externally (e.g. from session tree) to reload history for the current active session. */
    public reloadHistory(): void {
        this.cachedHistory = [];
        this.activeRuns.clear();
        this.restoreHistory();
    }
}
