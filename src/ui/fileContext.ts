import * as vscode from 'vscode';
import {
  onSelectionChanged,
  onActiveEditorChanged,
  getCurrentSelection,
  SelectionData,
} from '../context/selection-tracker.js';

// ─── Pill data (to/from webview) ───────────────────────────────────────────

export interface PillData {
  filePath: string;
  displayText: string;
  isLive: boolean;
  startLine?: number;
  endLine?: number;
}

// ─── Module state ──────────────────────────────────────────────────────────

let webviewRef: vscode.Webview | null = null;
let livePillEnabled = false;

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDisplayText(data: SelectionData): string {
  const relativePath = vscode.workspace.asRelativePath(data.filePath);
  if (data.isEmpty) return relativePath;
  if (data.startLine === data.endLine) return `${relativePath}:${data.startLine}`;
  return `${relativePath}:${data.startLine}-${data.endLine}`;
}

// ─── Activation ────────────────────────────────────────────────────────────

/**
 * Register right-click menu commands and wire live selection tracking.
 * Call once from extension activate() after the webview is created.
 */
export function activateFileContext(
  webview: vscode.Webview,
  subscriptions: vscode.Disposable[],
): void {
  webviewRef = webview;

  // ── "Add to Thread" — editor/context (right-click on selection) ──────

  subscriptions.push(
    vscode.commands.registerCommand('openclaw.addToThread', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') return;

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const sel = editor.selection;

      if (sel.isEmpty) {
        // No selection — attach the file with cursor position
        const line = sel.start.line + 1;
        webview.postMessage({
          type: 'addPill',
          filePath,
          displayText: `${filePath}:${line}`,
          isLive: false,
        });
      } else {
        const start = sel.start.line + 1;
        const end = sel.end.line + 1;
        const range = start === end ? `${start}` : `${start}-${end}`;
        webview.postMessage({
          type: 'addPill',
          filePath,
          displayText: `${filePath}:${range}`,
          isLive: false,
        });
      }
    }),
  );

  // ── "Add File to Thread" — editor/title/context (right-click on tab) ──

  subscriptions.push(
    vscode.commands.registerCommand('openclaw.addFileToThread', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri || targetUri.scheme !== 'file') return;

      const filePath = vscode.workspace.asRelativePath(targetUri);
      webview.postMessage({
        type: 'addPill',
        filePath,
        displayText: filePath,
        isLive: false,
      });
    }),
  );

  // ── Wire live selection tracking ──────────────────────────────────────

  subscriptions.push(...wireLiveTracking(webview));
}

// ─── Live tracking ─────────────────────────────────────────────────────────

function wireLiveTracking(webview: vscode.Webview): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    onSelectionChanged((data) => {
      if (!livePillEnabled) return;

      const displayText = formatDisplayText(data);
      webview.postMessage({
        type: 'updateLivePill',
        filePath: data.filePath,
        displayText,
        enabled: true,
      });
    }),
  );

  disposables.push(
    onActiveEditorChanged((data) => {
      if (!livePillEnabled) return;
      if (!data) {
        webview.postMessage({
          type: 'updateLivePill',
          filePath: '',
          displayText: '',
          enabled: false,
        });
        return;
      }
      const displayText = formatDisplayText(data);
      webview.postMessage({
        type: 'updateLivePill',
        filePath: data.filePath,
        displayText,
        enabled: true,
      });
    }),
  );

  return disposables;
}

// ─── Toggle (from webview) ─────────────────────────────────────────────────

/** Called from chatBase when the webview sends { type: 'toggleLivePill', enabled }. */
export function handleToggleLivePill(enabled: boolean): void {
  livePillEnabled = enabled;
  if (enabled) {
    const current = getCurrentSelection();
    if (current && webviewRef) {
      webviewRef.postMessage({
        type: 'updateLivePill',
        filePath: current.filePath,
        displayText: formatDisplayText(current),
        enabled: true,
      });
    }
  }
}

// ─── Build context block ───────────────────────────────────────────────────

/**
 * Build a file-context block from pill data to prepend to agent messages.
 * Called at send time so the context is always up to date.
 */
export function buildFileContext(pills: PillData[]): string {
  if (pills.length === 0) return '';

  return (
    pills
      .map((p) => {
        if (p.isLive && p.startLine !== undefined) {
          return `Current file: ${p.filePath}:${p.startLine}-${p.endLine ?? p.startLine}`;
        }
        return `Attached file: ${p.filePath}`;
      })
      .join('\n') + '\n\n'
  );
}
