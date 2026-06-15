# Logging, Token Usage & Per-Window Isolation

## Logging

- `Logger` singleton (`utils/logger.ts`)
- File logging enabled in `globalStorageUri` on extension activate
- Debug stream capture: per-branch, per-bridge event filtering (key: `chat-stream-filtered`)
- `junction.showLogs` command opens the output channel

## Token Usage

| Bridge | Source |
|---|---|
| OpenClaw | `sessions.usage` RPC → `{ inputTokens, outputTokens, cost }` on demand |
| MiMoCode | Extracted from SSE response parts; emitted as `agent_lifecycle.usage` on completion |
| Hermes/Souveraine/Goose | Not reported |

`tokenUsage` event posted to webview after each completed run (inputTokens + outputTokens).  
Session-level usage notification: `Session usage: N tokens · $cost`.

## Per-Window Isolation

- One `ChatViewProvider` created per VS Code window (one extension host per window)
- Bridge registry built with `crypto.randomUUID()` instance ID
- OpenClaw gateway connections scoped to instance ID — prevents cross-window session leakage
- `viewSessionKey` on each view gates all stream events — only events for the displayed session reach the UI
- `activeRunIdsBySession` Map scoped per view instance
