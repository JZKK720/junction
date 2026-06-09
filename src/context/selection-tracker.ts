import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full state snapshot used for structural-diff comparison. */
interface SelectionState {
    filePath: string;
    startLine: number;
    endLine: number;
    startCharacter: number;
    endCharacter: number;
    isEmpty: boolean;
    text: string;
}

/** Public payload delivered to callbacks. */
export interface SelectionData {
    filePath: string;
    startLine: number;
    endLine: number;
    startCharacter: number;
    endCharacter: number;
    selectedText?: string;
    isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastState: SelectionState | null = null;

// ---------------------------------------------------------------------------
// Bump-token debounce (no timers)
// ---------------------------------------------------------------------------

let tokenCounter = 0;

function bump(): number {
    return ++tokenCounter;
}

function isStale(token: number): boolean {
    return token !== tokenCounter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a SelectionState snapshot from the active text editor. */
function captureState(editor: vscode.TextEditor): SelectionState | null {
    const doc = editor.document;
    const sel = editor.selection;
    const text = sel.isEmpty ? '' : doc.getText(sel);

    return {
        filePath: doc.fileName,
        startLine: sel.start.line,
        endLine: sel.end.line,
        startCharacter: sel.start.character,
        endCharacter: sel.end.character,
        isEmpty: sel.isEmpty,
        text,
    };
}

/**
 * Structural-diff comparison: byte-for-byte across all 7 fields.
 * Returns true if the two states are identical (no change).
 */
function isIdentical(a: SelectionState | null, b: SelectionState | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.filePath === b.filePath &&
        a.startLine === b.startLine &&
        a.endLine === b.endLine &&
        a.startCharacter === b.startCharacter &&
        a.endCharacter === b.endCharacter &&
        a.isEmpty === b.isEmpty &&
        a.text === b.text
    );
}

/** Convert internal state to the public SelectionData shape. */
function toSelectionData(state: SelectionState | null): SelectionData | null {
    if (!state) return null;
    return {
        filePath: state.filePath,
        startLine: state.startLine,
        endLine: state.endLine,
        startCharacter: state.startCharacter,
        endCharacter: state.endCharacter,
        selectedText: state.isEmpty ? undefined : state.text,
        isEmpty: state.isEmpty,
    };
}

/** Skip virtual / output documents. */
function isIgnoredScheme(uri: vscode.Uri): boolean {
    const scheme = uri.scheme;
    return scheme === 'comment' || scheme === 'output';
}

// ---------------------------------------------------------------------------
// Retain policy for tab-switch to null
// ---------------------------------------------------------------------------

/**
 * When the active editor becomes null (e.g. user closed all tabs), decide
 * whether to clear selection state or retain it.
 *
 * Retain behavior:
 *   - If there are zero visible text editors  → clear
 *   - Otherwise                             → retain (keep last known state)
 */
function getRetainPolicy(): 'clear' | 'retain' {
    return vscode.window.visibleTextEditors.length === 0 ? 'clear' : 'retain';
}

// ---------------------------------------------------------------------------
// Callback registries
// ---------------------------------------------------------------------------

type SelectionCallback = (data: SelectionData) => void;
type ActiveEditorCallback = (data: SelectionData | null) => void;

const selectionCallbacks = new Set<SelectionCallback>();
const activeEditorCallbacks = new Set<ActiveEditorCallback>();

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Fire the current selection to all registered selection-changed callbacks.
 * Only fires when the snapshot actually differs from lastState.
 */
function fireIfChanged(state: SelectionState | null): void {
    if (isIdentical(lastState, state)) return;

    lastState = state;
    const data = toSelectionData(state);
    if (!data) return;

    selectionCallbacks.forEach((cb) => {
        try {
            cb(data);
        } catch {
            // swallow – don't let one broken listener break the pipeline
        }
    });
}

/**
 * Fire to all active-editor-changed callbacks (including null).
 * Always fires on tab switch, regardless of diff.
 */
function fireActiveEditorChanged(state: SelectionState | null): void {
    const data = toSelectionData(state);
    activeEditorCallbacks.forEach((cb) => {
        try {
            cb(data);
        } catch {
            // swallow
        }
    });
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

/**
 * onDidChangeTextEditorSelection handler.
 *
 * – Gated to active editor only.
 * – Skips virtual schemes (comment, output).
 * – Bump-token protects async work (like resolveWorkspace).
 * – Structural diff before firing.
 */
async function handleSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): Promise<void> {
    // Active-editor gate
    if (e.textEditor !== vscode.window.activeTextEditor) return;

    // Scheme filter
    if (isIgnoredScheme(e.textEditor.document.uri)) return;

    const token = bump();

    // Placeholder for async workspace resolution (e.g. .gitignore-aware path).
    // In this reference implementation the state is built synchronously, but
    // any future async step (resolveWorkspace, postMessage, etc.) MUST check
    // isStale(token) before proceeding.
    //
    // Example:
    //   const resolved = await resolveWorkspace(editor.document.uri);
    //   if (isStale(token)) return;

    const state = captureState(e.textEditor);
    if (!state) return;

    // If all selections were removed, fire null/clear
    if (e.selections.length === 0) {
        lastState = null;
        selectionCallbacks.forEach((cb) => {
            try {
                cb({ filePath: '', startLine: 0, endLine: 0, startCharacter: 0, endCharacter: 0, isEmpty: true });
            } catch { /* swallow */ }
        });
        return;
    }

    fireIfChanged(state);
}

/**
 * onDidChangeActiveTextEditor handler.
 *
 * – null editor: apply retain policy.
 * – new editor: capture immediately, no debounce.
 */
async function handleActiveEditorChanged(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor) {
        // No active editor – check retain policy
        if (getRetainPolicy() === 'retain') {
            // Keep current state, fire as-is (already in lastState)
            fireActiveEditorChanged(lastState);
            return;
        }
        // Clear
        bump(); // invalidate any in-flight async work
        lastState = null;
        fireActiveEditorChanged(null);
        return;
    }

    // New active editor: capture + fire immediately
    const token = bump();
    const state = captureState(editor);

    // (async work checkpoint – isStale(token) check goes here)

    fireIfChanged(state);
    fireActiveEditorChanged(state);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a callback that fires when the selection *structurally changes*
 * in the active editor.  No-op when the new selection is byte-identical to
 * the previous one.
 *
 * Returns a Disposable; dispose it to unregister.
 */
export function onSelectionChanged(callback: SelectionCallback): vscode.Disposable {
    selectionCallbacks.add(callback);
    return new vscode.Disposable(() => {
        selectionCallbacks.delete(callback);
    });
}

/**
 * Register a callback that fires whenever the active editor changes.
 * Receives null when there is no active editor (and retain policy says clear).
 *
 * Returns a Disposable; dispose it to unregister.
 */
export function onActiveEditorChanged(callback: ActiveEditorCallback): vscode.Disposable {
    activeEditorCallbacks.add(callback);
    return new vscode.Disposable(() => {
        activeEditorCallbacks.delete(callback);
    });
}

/**
 * Return the current (last-known) selection state, or null.
 */
export function getCurrentSelection(): SelectionData | null {
    return toSelectionData(lastState);
}

// ---------------------------------------------------------------------------
// Bootstrap – wire up VS Code listeners
// ---------------------------------------------------------------------------

let disposables: vscode.Disposable[] | null = null;

export function activate(): vscode.Disposable {
    if (disposables) {
        // already activated
        return { dispose: () => deactivate() };
    }

    // Capture initial state from the currently-active editor
    const active = vscode.window.activeTextEditor;
    if (active && !isIgnoredScheme(active.document.uri)) {
        lastState = captureState(active);
    }

    disposables = [
        vscode.window.onDidChangeTextEditorSelection(handleSelectionChanged),
        vscode.window.onDidChangeActiveTextEditor(handleActiveEditorChanged),
    ];

    return { dispose: () => deactivate() };
}

export function deactivate(): void {
    if (disposables) {
        disposables.forEach((d) => d.dispose());
        disposables = null;
    }
    lastState = null;
    selectionCallbacks.clear();
    activeEditorCallbacks.clear();
}
