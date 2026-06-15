import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { BridgeRegistry } from '../bridges/registry';
import { OpenClawBridge } from '../bridges/openclaw/OpenClawBridge';
import { HermesBridge } from '../bridges/hermes/HermesBridge';
import { SouveraineBridge } from '../bridges/souveraine/SouveraineBridge';
import { MiMoCodeBridge } from '../bridges/mimocode/MiMoCodeBridge';
import { ChatBase } from './chatBase';

/**
 * Per-window ChatViewProvider. VS Code runs one extension host per window,
 * so one provider instance == one window. The registry (and its gateway
 * connections) is built here with a window-unique instanceId rather than the
 * old globalState-shared id, which leaked one identity across windows.
 */
export class ChatViewProvider extends ChatBase implements vscode.WebviewViewProvider {
    public static readonly viewType = 'junction.chatView';
    private _view?: vscode.WebviewView;

    constructor(context: vscode.ExtensionContext) {
        // Bridges + CheckpointManager need the real ExtensionContext
        // (globalState, storage paths) — never a stub.
        const registry = new BridgeRegistry(context);
        const instanceId = `junction-${crypto.randomUUID()}`;
        registry.register(new OpenClawBridge(context, instanceId));
        registry.register(new HermesBridge(context));
        registry.register(new SouveraineBridge(context));
        registry.register(new MiMoCodeBridge(context));
        super(context.extensionUri, registry);
    }

    /** Window-scoped registry, exposed for status bar + command wiring. */
    public get registry(): BridgeRegistry {
        return this.bridgeRegistry;
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
