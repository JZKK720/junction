# Hermes Bridge

**Protocol:** WebSocket JSON-RPC (dashboard endpoint)  
**Capabilities:** sessions ✓ · models ✓ · agents ✗ · steering ✓ · usage ✗ · tools ✓

## Connection

- Dashboard token auth: scrapes `__HERMES_SESSION_TOKEN__` from HTML at `dashboardUrl`
- WS: `ws://<host>/api/ws?token=<token>`
- Sessions and active session ID persisted in `workspaceState`

## Managed Runtime Spawn

- Detects dashboard at `dashboardUrl`; if unreachable, spawns it
- Command: `uv run --locked --extra web python -m hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --no-open --tui --skip-build`
- Falls back to `python` if `uv` not on PATH
- Logs to `<hermesHome>/logs/dashboard.log`
- Polls up to 30 s for dashboard to become reachable
- Requires `junction.hermes.repoPath` set; no-op if empty

## Auto-Detection

- Port sniffer: checks ports 9119, 9120, 9000, 8642, 8000; matches on `__HERMES_SESSION_TOKEN__` in HTML response
- Config sniffer: reads `<hermesHome>/config.{yaml,json,toml}` for `port:` field; probes that port first before scanning known ports
- Rationale: user may have changed port but left config intact, or vice versa; both paths tried in sequence

## Session Management

- `session.create` RPC → `{ session_id }`
- `session.history` RPC → `{ messages: [{ role, text }] }`
- Rename: client-side only (no server RPC)
- Sessions grouped under `Recent`

## Model Picker

- `model.options` RPC → `{ providers: [{ slug, models: [...] }] }`
- Per-model reasoning efforts extracted from: `supported_reasoning_efforts`, `supportedReasoningEfforts`, `reasoning_efforts`, `reasoning_levels`, `thinking_levels`, `thinking_options`
- If model supports reasoning but advertises no efforts: falls back to canonical OpenClaw levels (`off minimal low medium high`)
- Reasoning submenu hidden if model does not support reasoning

## Steering

- `injectMessage`: sends `prompt.submit` with text `/steer <message>`
- Stop: `session.interrupt` RPC

## Environment Label

- Derived from `hermesHome` directory name (strips `hermes-` prefix)
