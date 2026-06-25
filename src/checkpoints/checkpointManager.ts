import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { Logger } from '../utils/logger';
import { config } from '../config/agentBridgeConfig';

/**
 * CheckpointManager — VSCode-side "rewind code to here".
 *
 * Snapshots the workspace at each user-turn boundary into a **shadow git repo**
 * with a separate `--git-dir` (kept in the extension's global storage), so it
 * never touches the user's real `.git`. The local openclaw gateway edits files
 * on the same filesystem VSCode sees, so these snapshots capture agent edits.
 *
 * Rewinding restores tracked files to the snapshot and removes files the shadow
 * repo recorded as *added* since (scoped — never a blanket `git clean`, so the
 * user's unrelated untracked files are left alone). A rewind first snapshots the
 * current state, so the rewind itself is undoable.
 */
export class CheckpointManager {
    private logger = Logger.getInstance();
    private gitDir: string | null = null;
    private workTree: string | null = null;
    private initialized = false;
    /** messageId → commit sha */
    private map: Record<string, string> = {};
    private touchedPaths = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.map = context.workspaceState.get<Record<string, string>>('junction.checkpoints', {});
    }

    isEnabled(): boolean {
        return config().get<boolean>('checkpoints.enabled', false);
    }

    hasCheckpoint(messageId: string): boolean {
        return !!this.map[messageId];
    }

    recordTouchedPath(filePath: string | undefined): void {
        const rel = this.normalizeWorkspaceRelPath(filePath);
        if (rel) this.touchedPaths.add(rel);
    }

    private normalizeWorkspaceRelPath(filePath: string | undefined): string | null {
        if (!filePath) return null;
        const root = this.workspaceRoot();
        let rel = filePath.replace(/\\/g, '/').trim();
        if (!rel) return null;
        if (root && path.isAbsolute(rel)) {
            const relative = path.relative(root, rel).replace(/\\/g, '/');
            if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
            rel = relative;
        }
        if (rel.startsWith('/') || rel.split('/').includes('..')) return null;
        return rel;
    }

    recordTouchedPathsFromValue(value: any): void {
        const visit = (item: any) => {
            if (!item || typeof item !== 'object') return;
            for (const key of ['path', 'file', 'filePath', 'filename', 'target', 'targetPath']) {
                if (typeof item[key] === 'string') this.recordTouchedPath(item[key]);
            }
            for (const child of Object.values(item)) {
                if (Array.isArray(child)) child.forEach(visit);
                else if (child && typeof child === 'object') visit(child);
            }
        };
        visit(value);
    }

    private workspaceRoot(): string | null {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    }

    private run(args: string[], trimOutput = true): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.gitDir || !this.workTree) return reject(new Error('checkpoints not initialized'));
            const env = { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workTree };
            // Stable identity so commits never fall back to the user's git config.
            const full = ['-c', 'user.email=checkpoints@junction.local', '-c', 'user.name=Junction Checkpoints', ...args];
            exec('git ' + full.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' '), { env, cwd: this.workTree, maxBuffer: 64 * 1024 * 1024 },
                (err, stdout, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve(trimOutput ? stdout.trim() : stdout);
                });
        });
    }

    private diffScratchPath(kind: 'before' | 'current', sha: string, rel: string): string {
        return path.join(this.context.globalStorageUri.fsPath, 'checkpoint-diffs', sha.slice(0, 12), kind, rel);
    }

    private writeScratchFile(kind: 'before' | 'current', sha: string, rel: string, content: string): string {
        const target = this.diffScratchPath(kind, sha, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        return target;
    }

    /** Ensure the shadow repo exists for the current workspace. */
    private async ensureInit(): Promise<boolean> {
        if (this.initialized) return true;
        const root = this.workspaceRoot();
        if (!root) return false;

        const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
        const base = path.join(this.context.globalStorageUri.fsPath, 'checkpoints', hash);
        this.gitDir = path.join(base, 'git');
        this.workTree = root;

        try {
            fs.mkdirSync(this.gitDir, { recursive: true });
            if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
                await this.run(['init']);
                // Honor .gitignore + always exclude heavy/irrelevant trees and our own dir.
                const exclude = path.join(this.gitDir, 'info', 'exclude');
                fs.mkdirSync(path.dirname(exclude), { recursive: true });
                fs.writeFileSync(exclude, ['node_modules/', '.git/', '.openclaw/', '.junction/', ''].join('\n'));
            }
            this.initialized = true;
            return true;
        } catch (err) {
            this.logger.warn('checkpoint init failed', err);
            return false;
        }
    }

    private async persist(): Promise<void> {
        await this.context.workspaceState.update('junction.checkpoints', this.map);
    }

    /** Snapshot the workspace, tagging it with a message id. Returns commit sha. */
    async snapshot(messageId: string, label: string): Promise<string | null> {
        if (!this.isEnabled()) return null;
        if (!(await this.ensureInit())) return null;
        try {
            await this.run(['add', '-A']);
            await this.run(['commit', '--allow-empty', '--no-verify', '-m', label.slice(0, 72) || 'checkpoint']);
            const sha = await this.run(['rev-parse', 'HEAD']);
            this.map[messageId] = sha;
            await this.persist();
            return sha;
        } catch (err) {
            this.logger.warn('checkpoint snapshot failed', err);
            return null;
        }
    }

    /**
     * Restore the workspace to the snapshot for `messageId`. Destructive —
     * the caller must confirm with the user first.
     */
    async rewindTo(messageId: string): Promise<boolean> {
        if (!(await this.ensureInit())) return false;
        const sha = this.map[messageId];
        if (!sha) {
            vscode.window.showWarningMessage('No checkpoint found for this message.');
            return false;
        }
        try {
            // Make the rewind itself undoable.
            await this.snapshot('pre-rewind-' + Date.now().toString(36), 'before rewind');

            // Restore tracked files to the snapshot.
            await this.run(['checkout', sha, '--', '.']);

            // Remove files the shadow repo recorded as ADDED since the snapshot
            // (scoped — never touches ignored or unrelated untracked files).
            let added = '';
            try { added = await this.run(['diff', '--name-only', '--diff-filter=A', sha]); } catch { /* none */ }
            const root = this.workTree!;
            for (const rel of added.split('\n').map((s) => s.trim()).filter(Boolean)) {
                if (!this.touchedPaths.has(rel)) continue;
                try { fs.rmSync(path.join(root, rel), { force: true }); } catch { /* ignore */ }
            }
            return true;
        } catch (err) {
            this.logger.error('checkpoint rewind failed', err);
            vscode.window.showErrorMessage('Rewind failed: ' + String(err));
            return false;
        }
    }

    async reviewDiff(messageId: string | undefined, files?: string[]): Promise<void> {
        if (!messageId) {
            vscode.window.showWarningMessage('No checkpoint found for this edit summary.');
            return;
        }
        if (!(await this.ensureInit())) return;
        const sha = this.map[messageId];
        if (!sha) {
            vscode.window.showWarningMessage('No checkpoint found for this message.');
            return;
        }

        let rels = Array.from(new Set(
            (Array.isArray(files) ? files : [])
                .map((file) => this.normalizeWorkspaceRelPath(file))
                .filter((file): file is string => !!file)
        ));

        if (!rels.length) {
            try {
                const changed = await this.run(['diff', '--name-only', sha, '--', '.']);
                rels = changed.split('\n').map((line) => line.trim()).filter(Boolean);
            } catch (err) {
                this.logger.warn('checkpoint diff file discovery failed', err);
            }
        }

        if (!rels.length) {
            vscode.window.showInformationMessage('No changed files found for this checkpoint.');
            return;
        }

        const root = this.workTree!;
        let opened = 0;
        for (const rel of rels) {
            let before = '';
            try {
                before = await this.run(['show', `${sha}:${rel}`], false);
            } catch {
                before = '';
            }

            const beforePath = this.writeScratchFile('before', sha, rel, before);
            const currentPath = path.join(root, rel);
            let rightUri: vscode.Uri;
            if (fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()) {
                rightUri = vscode.Uri.file(currentPath);
            } else {
                rightUri = vscode.Uri.file(this.writeScratchFile('current', sha, rel, ''));
            }

            await vscode.commands.executeCommand(
                'vscode.diff',
                vscode.Uri.file(beforePath),
                rightUri,
                `${rel} (checkpoint <-> current)`
            );
            opened += 1;
        }

        if (!opened) {
            vscode.window.showInformationMessage('No reviewable files found for this checkpoint.');
        }
    }
}
