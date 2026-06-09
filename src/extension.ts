import * as vscode from 'vscode';
import { BridgeRegistry } from './bridges/registry';
import { OpenClawBridge } from './bridges/openclaw/OpenClawBridge';
import { HermesBridge } from './bridges/hermes/HermesBridge';
import { SouveraineBridge } from './bridges/souveraine/SouveraineBridge';
import { ChatViewProvider } from './ui/chatViewProvider';
import { registerSendFilePathCommand } from './commands/sendFilePath';
import { registerShowLogsCommand } from './commands/showLogs';
import { Logger } from './utils/logger';
import { WorkspaceTracker } from './context/workspaceTracker';
import { onActiveEditorChanged, onSelectionChanged } from './context/selection-tracker';
import { registerTodoCodeLensCommand, registerTodoCodeLensProvider } from './context/todoCodeLens';

let bridgeRegistry: BridgeRegistry;
let logger: Logger;
let workspaceTracker: WorkspaceTracker;
let chatViewProvider: ChatViewProvider | undefined;

async function activate(context: vscode.ExtensionContext) {
    logger = Logger.getInstance();
    logger.enableFileLogging(context);
    logger.info('Junction extension activating');

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = '$(sync~spin) Junction';
    statusBar.tooltip = 'Junction: connecting...';
    statusBar.command = 'junction.configureRuntime';
    statusBar.show();
    context.subscriptions.push(statusBar);

    let instanceId = context.globalState.get<string>('junction.instanceId')
        || context.globalState.get<string>('openclaw.instanceId');
    if (!instanceId) {
        const { randomUUID } = await import('crypto');
        instanceId = randomUUID();
    }
    await context.globalState.update('junction.instanceId', instanceId);

    bridgeRegistry = new BridgeRegistry(context);
    bridgeRegistry.register(new OpenClawBridge(context, instanceId));
    bridgeRegistry.register(new HermesBridge(context));
    bridgeRegistry.register(new SouveraineBridge(context));

    for (const bridge of bridgeRegistry.getAll()) {
        bridge.on('connected', () => {
            if (bridgeRegistry.active !== bridge) return;
            statusBar.text = `$(check) ${bridge.label}`;
            statusBar.tooltip = `Junction: connected to ${bridge.label}`;
            statusBar.backgroundColor = undefined;
        });
        bridge.on('disconnected', () => {
            if (bridgeRegistry.active !== bridge) return;
            statusBar.text = `$(debug-disconnect) ${bridge.label}`;
            statusBar.tooltip = `Junction: ${bridge.label} disconnected`;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        });
        bridge.on('pairingRequired', () => {
            if (bridgeRegistry.active !== bridge) return;
            statusBar.text = `$(key) ${bridge.label}: approval needed`;
            statusBar.tooltip = `${bridge.label}: waiting for local approval`;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        });
    }

    bridgeRegistry.on('changed', (bridge) => {
        statusBar.text = `$(sync~spin) ${bridge.label}`;
        statusBar.tooltip = `Junction: connecting to ${bridge.label}`;
        statusBar.backgroundColor = undefined;
    });

    chatViewProvider = new ChatViewProvider(context.extensionUri, bridgeRegistry);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
    );
    context.subscriptions.push(
        onSelectionChanged((data) => chatViewProvider?.updateLiveSelectionPill(data)),
        onActiveEditorChanged((data) => chatViewProvider?.updateLiveSelectionPill(data)),
    );

    workspaceTracker = new WorkspaceTracker();
    workspaceTracker.onAutoSendFileContext((fileContext) => {
        bridgeRegistry.active.setPendingFileContext(fileContext);
    });
    context.subscriptions.push(...workspaceTracker.disposables);

    registerSendFilePathCommand(context, bridgeRegistry);
    registerShowLogsCommand(context);
    registerTodoCodeLensProvider(context, () => chatViewProvider);
    registerTodoCodeLensCommand(context, () => chatViewProvider);
    registerCommands(context);

    logger.info('Junction extension activated');
    void bridgeRegistry.connectActive()
        .then(() => logger.info('Connected active bridge'))
        .catch((error) => logger.error('Failed to connect active bridge', error));
}

function registerCommands(context: vscode.ExtensionContext): void {
    const focusSidebar = async () => {
        await vscode.commands.executeCommand('workbench.view.extension.junction-explorer');
        await Promise.resolve(vscode.commands.executeCommand('junction.chatView.focus')).catch(() => {});
    };

    const configureRuntime = async () => bridgeRegistry.active.configure();
    const openChat = async () => focusSidebar();
    const addToThread = async () => {
        if (!chatViewProvider) {
            await focusSidebar();
            vscode.window.showWarningMessage('Junction sidebar is still starting.');
            return;
        }
        chatViewProvider.addEditorSelectionPill();
        await focusSidebar();
    };
    const addFileToThread = async (uri?: vscode.Uri) => {
        if (!chatViewProvider) {
            await focusSidebar();
            vscode.window.showWarningMessage('Junction sidebar is still starting.');
            return;
        }
        chatViewProvider.addFilePill(uri);
        await focusSidebar();
    };
    const openExternalComposer = async () => {
        if (!chatViewProvider) await focusSidebar();
        await chatViewProvider?.openExternalComposer('');
    };
    const sendExternalComposer = async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        if (!chatViewProvider) await focusSidebar();
        await chatViewProvider?.sendExternalComposerText(editor.document.getText());
        await focusSidebar();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('junction.configureRuntime', configureRuntime),
        vscode.commands.registerCommand('junction.openChat', openChat),
        vscode.commands.registerCommand('junction.addToThread', addToThread),
        vscode.commands.registerCommand('junction.addFileToThread', addFileToThread),
        vscode.commands.registerCommand('junction.openExternalComposer', openExternalComposer),
        vscode.commands.registerCommand('junction.sendExternalComposer', sendExternalComposer),
        vscode.commands.registerCommand('junction.rewindToCheckpoint', async () => vscode.window.showInformationMessage('Use a message row checkpoint marker to rewind.')),

        // Hidden compatibility aliases. Not contributed in package.json.
        vscode.commands.registerCommand('openclaw.configureGateway', configureRuntime),
        vscode.commands.registerCommand('openclaw.openChat', openChat),
        vscode.commands.registerCommand('openclaw.addToThread', addToThread),
        vscode.commands.registerCommand('openclaw.addFileToThread', addFileToThread),
        vscode.commands.registerCommand('openclaw.openExternalComposer', openExternalComposer),
        vscode.commands.registerCommand('openclaw.sendExternalComposer', sendExternalComposer),
    );
}

function deactivate() {
    if (logger) logger.info('Junction extension deactivating');
    if (bridgeRegistry) bridgeRegistry.disconnectAll();
}

export { activate, deactivate };
