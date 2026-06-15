# Context Tracking

## Selection Tracker (`selection-tracker.ts`)

- Listens to `onDidChangeActiveTextEditor` and `onDidChangeTextEditorSelection`
- Emits `SelectionData`: `{ filePath, startLine, endLine, selectedText, isEmpty }`
- Used by:
  - Live selection pill (real-time cursor position updates)
  - `gatherContext()` at send time (active file, language, selection range)

## Workspace Tracker (`workspaceTracker.ts`)

- Fires `onAutoSendFileContext` callback when active file changes
- Callback calls `bridge.setPendingFileContext(fileContext)`
- Pending context consumed once on next message send
- Interval: `junction.fileContextInterval` ms (default 5000)
- Toggle: `junction.autoSendFileContext`

## `gatherContext()`

At send time, collects:
- `workspace`: workspace folder fsPath
- `workspaceFolder`: same as workspace
- `activeFile`: current editor document fileName
- `language`: current editor language ID
- `selection`: `{ start, end }` (line numbers)

Passed as `BridgeContext` to `bridge.sendChatMessage()`.
