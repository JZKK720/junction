import * as vscode from 'vscode';
import { WorkspaceContext } from '../types/openclaw';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/agentBridgeConfig';

export class WorkspaceTracker {
    private currentContext: WorkspaceContext = {};
    readonly disposables: vscode.Disposable[] = [];
    private onFileContextCallback?: (context: string) => void;
    private autoSendTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateWorkspaceContext()),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this.updateEditorContext(editor);
                this.scheduleAutoSend();
            }),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document === vscode.window.activeTextEditor?.document) {
                    this.updateDocumentContext(e.document);
                }
            }),
            { dispose: () => { if (this.autoSendTimer) clearTimeout(this.autoSendTimer); } }
        );
        this.updateWorkspaceContext();
        this.updateEditorContext(vscode.window.activeTextEditor);
    }

    /** Register a callback that receives formatted file context when auto-send fires. */
    onAutoSendFileContext(cb: (context: string) => void): void {
        this.onFileContextCallback = cb;
    }

    private scheduleAutoSend(): void {
        const cfg = config();
        if (!cfg.get<boolean>('autoSendFileContext', true)) return;
        const interval = cfg.get<number>('fileContextInterval', 5000);

        if (this.autoSendTimer) clearTimeout(this.autoSendTimer);
        this.autoSendTimer = setTimeout(() => {
            this.autoSendTimer = null;
            const ctx = this.currentContext;
            if (!ctx.activeFile || !this.onFileContextCallback) return;
            const editor = vscode.window.activeTextEditor;
            let msg = `Current file: ${ctx.activeFile.path}`;
            if (editor && !editor.selection.isEmpty) {
                const sel = editor.document.getText(editor.selection);
                msg += `\n\nSelected code:\n\`\`\`${ctx.activeFile.language}\n${sel}\n\`\`\``;
            }
            this.onFileContextCallback(msg);
        }, interval);
    }

    private updateWorkspaceContext(): void {
        const workspaces = vscode.workspace.workspaceFolders;

        if (workspaces && workspaces.length > 0) {
            this.currentContext.workspace = {
                name: workspaces[0].name,
                path: workspaces[0].uri.fsPath,
                type: this.detectProjectType(workspaces[0].uri.fsPath)
            };
        }
    }

    private updateEditorContext(editor: vscode.TextEditor | undefined): void {
        if (!editor) {
            this.currentContext.activeFile = undefined;
            return;
        }

        this.currentContext.activeFile = {
            path: editor.document.fileName,
            language: editor.document.languageId,
            lineCount: editor.document.lineCount,
            selection: editor.selection ? {
                start: editor.selection.start.line,
                end: editor.selection.end.line,
                text: editor.document.getText(editor.selection)
            } : undefined
        };
    }

    private updateDocumentContext(document: vscode.TextDocument): void {
        if (this.currentContext.activeFile) {
            this.currentContext.activeFile.lineCount = document.lineCount;
        }
    }

    private detectProjectType(workspacePath: string): string {
        // Check for common project files
        const indicators = [
            { file: 'package.json', type: 'Node.js' },
            { file: 'Cargo.toml', type: 'Rust' },
            { file: 'go.mod', type: 'Go' },
            { file: 'requirements.txt', type: 'Python' },
            { file: 'pom.xml', type: 'Java/Maven' },
            { file: 'build.gradle', type: 'Java/Gradle' },
            { file: 'CMakeLists.txt', type: 'C/C++' }
        ];

        for (const indicator of indicators) {
            if (fs.existsSync(path.join(workspacePath, indicator.file))) {
                return indicator.type;
            }
        }

        return 'Unknown';
    }

    public getContext(): WorkspaceContext {
        return { ...this.currentContext };
    }

    public augmentMessage(message: string): string {
        const ctx = this.getContext();
        let augmented = message;

        if (ctx.workspace) {
            augmented = `[Workspace: ${ctx.workspace.name} (${ctx.workspace.type})]\n${augmented}`;
        }

        if (ctx.activeFile) {
            augmented = `[Active File: ${ctx.activeFile.path} (${ctx.activeFile.language})]\n${augmented}`;

            if (ctx.activeFile.selection && ctx.activeFile.selection.text) {
                augmented += `\n\n[Selected Code]\n\`\`\`${ctx.activeFile.language}\n${ctx.activeFile.selection.text}\n\`\`\``;
            }
        }

        return augmented;
    }
}
