# Message Composition & Dispatch

## Send Behavior

| Mode | Behavior |
|---|---|
| `enter` | Enter sends; Shift+Enter = newline |
| `ctrlEnter` | Ctrl/Cmd+Enter sends; Enter = newline |
| `smartEnter` | Single-line: Enter sends; multi-line: Ctrl/Cmd+Enter sends |

## Message Prefixes

| Prefix | Routing |
|---|---|
| `!` | Prepends shell-command intent note before sending |
| `#` | Prepends memory/context intent note before sending |
| `/` | Slash command autocomplete (suggestions from bridge) |

## File Attachment (Pills)

| Source | Method |
|---|---|
| Dialog | `junction.addToThread` command or attach button — multi-select |
| Editor context menu | `junction.addToThread` — attaches current selection |
| Explorer / title | `junction.addFileToThread` — attaches whole file |
| Paste (text/binary) | Dropped/pasted file saved to `globalStorageUri/pasted/`; displayed as pill |
| Programmatic | `addFilePill(uri)` called from CodeLens or external code |

Pills carry: `filePath`, `displayText`, `isLive`, `startLine?`, `endLine?`, `selectedText?`, `language?`

Binary files detected by null-byte scan and replaced with `[binary file omitted]`.  
Files > 60,000 chars truncated with `[truncated N chars]` note.

## Live Selection Pill

- Tracks cursor position in real time via `selection-tracker.ts`
- `updateLiveSelectionPill()` called on `onDidChangeActiveTextEditor` + `onDidChangeTextEditorSelection`
- Display text: `path:startLine` (no selection) or `path:startLine-endLine` (range)
- Toggle on/off; when off, pill removed from `attachedPills`

## Workspace Context

- Active workspace folder path sent as `BridgeContext.workspace`
- Bridges prepend `[Workspace: <path>]\n` to message text when present
- Hidden from transcript display

## Auto File Context

- `WorkspaceTracker` stages editor context on active file change
- Interval: `junction.fileContextInterval` ms (default 5000)
- Toggle: `junction.autoSendFileContext`
- Calls `bridge.setPendingFileContext(fileContext)` — consumed on next send

## Context Injection at Send Time

1. `bridge.getPendingFileContext()` (auto-staged editor context)
2. `buildAttachedFileContext()` (all attached pills)
3. Combined with `\n\n` separator
4. If `bridge.canAdminInject()`: sent as invisible `chat.inject`; otherwise prepended to user message text
