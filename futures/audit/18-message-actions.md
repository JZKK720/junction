# Message Actions

## Open File from Message

- Parses `path:line:col`, `path:line`, or bare path from message content
- Handles `~/` home expansion
- Relative paths resolved against workspace folder
- Opens document, jumps to position, reveals in editor (`InCenter`)

## Reactions

- Per-message up/down vote (`'up' | 'down' | null`)
- Stored in `TranscriptTurn.reaction`
- Persisted in transcript cache
- `handleSetReaction(messageId, value)` — no bridge sync

## Fork Conversation

- Creates new chat (`bridge.createChat()`)
- Injects transcript context up to selected message via `bridge.injectMessage()`
- Switches view to new session
- Re-fetches history for new session (shows injected context)
- `vscode.window.showInformationMessage('Conversation forked with local transcript context.')`

## Stop Run

- OpenClaw: sends `/stop` as a silent command (no UX echo, transcript entry hidden)
- Other bridges: `bridge.stopRun(sessionKey, runId)`

## Get Session Usage

- Requires `bridge.capabilities.usage`
- Calls `bridge.getUsage(sessionKey)` → posts `sessionUsage` to webview
- Shows notification: `Session usage: N tokens · $cost`

## Header Actions

Dispatched by webview `headerAction` message:

| Action ID | Effect |
|---|---|
| `rename` | Posts `startRename` to webview (inline rename mode) |
| `back` | Returns to session list |
| `usage` | Triggers `handleGetUsage()` |
| `archive` | Archives current session |
| `settings` | Opens VS Code settings for active bridge |
| `agentPicker` | Opens agent-picker choice menu |
| `fork` | Forks current conversation |
