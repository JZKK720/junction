# Goose Bridge

**Protocol:** REST + SSE (ACP — Agent Communication Protocol)  
**Capabilities:** sessions ✓ · models ✗ · agents ✗ · steering ✗ · usage ✗ · tools ✓

## Connection

- Or user-configured `junction.goose.serverUrl`
- No managed spawn (bridge detects external Goose server)
- `isConnected()` returns true if `baseUrl` is set

## Auto-Detection

- Port sniffer: HTTP probe `http://127.0.0.1:3284/` (Goose default ACP port)
- Config sniffer: reads `<gooseHome>/config.yaml` for `port:` or `server.port:` field; probes that URL before falling back to port 3284
- Rationale: user may have reconfigured Goose to a different port but not updated extension settings, or vice versa

## Session Management

- `POST /v1/sessions {}` → `{ id }`
- Sessions persisted in `workspaceState`
- History not implemented (returns empty array)
- Rename: client-side only

## Messaging

- `POST /v1/sessions/{id}/messages { role, content }` → SSE
- No stop/abort implemented
- No model picker, no steering

## Home / Binary

- Binary: `junction.goose.binaryPath` (auto-detect via `which goose`)
- Home: `junction.goose.home` (auto-detect `$XDG_DATA_HOME/goose` → `~/.goose`)

## Environment Label

- Reads `config.yaml` `name:` or `# <name>` from home dir
- Falls back to home dir basename
