# OpenClaw Bridge

**Protocol:** WebSocket JSON-RPC  
**Capabilities:** sessions ✓ · models ✓ · agents ✓ · steering ✓ · usage ✓ · tools ✓

## Connection

- Connects to `junction.openclaw.gatewayUrl` (default `ws://127.0.0.1:18789`)
- Device token pairing via `vscode.SecretStorage` (keys: `junction.openclaw.deviceToken`, `openclaw.deviceToken`)
- Capability negotiation on connect: `canListSessions`, `canListModels`, `canListAgents`, `canSteer`, `hasMethod`
- Reconnect support on disconnect

## Session Management

- Folder-scoped sessions: each workspace folder gets its own session binding
- Session watching/unwatching at transport level — gateway drops events for unwatched sessions
- `sessions.list` RPC for all sessions; owned session filter for folder scope
- `sessions.patch` RPC for rename (requires capability check)
- Chat index persisted to global storage: `bindingId → sessionKey`

## History

- `getSessionHistory(limit)` via gateway (default 200, 1000 with `showFullHistory`)
- `getSessionHistoryFromJsonl(sessionKey, offset, maxBytes)`: offset-based JSONL reader (256 KB chunks)

## Model & Agent Pickers

- `canListModels()` → calls `ModelManager.getModelChoices()`, cached per connection
- Agent picker via `listAgents()` RPC
- Per-session model override: `setSessionModel()` → `sessions.setModel` RPC; falls back to per-request-only on failure

## Tool Status

- `ToolStatusManager` loads enabled/disabled tool list from gateway
- Exposed as `ToolStatusView` to webview

## Steering & Injection

- Steer: `sessions.steer` RPC (or `canSteer()` capability) → fallback `chat.inject`
- Admin inject (`operator.admin` scope): `chat.inject` for invisible context messages
- Stop: sends `/stop` as a silent command (no UX echo)

## Usage

- `sessions.usage` RPC → `{ inputTokens, outputTokens, cost }`

## Runtime Discovery

- Auto-discover: port scans common ports for running gateways
- Config path picker: reads `openclaw.json`, derives `gateway.port` → `ws://127.0.0.1:<port>`
- Runtime label: derived from config path directory name or URL hostname
- Slash suggestions: loaded from gateway on connect via `CommandPalette`
