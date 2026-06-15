# MiMoCode Bridge

**Protocol:** REST + SSE streaming  
**Capabilities:** sessions ✓ · models ✓ · agents ✓ · steering ✗ · usage ✗ · tools ✓

## Connection

- External server URL: `junction.mimocode.serverUrl` — if set, connect without spawning
- Managed spawn otherwise
- Server URL and port stored in instance; `isConnected()` checks URL + (externalServer or serverProcess non-null)
- Sessions and active session ID persisted in `workspaceState`

## Managed Runtime Spawn

- Binary: `junction.mimocode.binaryPath` (default `"mimo"`, auto-discovered via `which mimo`)
- Command: `mimo serve --hostname 127.0.0.1 --port 0` (random port)
- Parses stdout/stderr for `listening on http://...`
- Home: XDG auto-discovery (`$XDG_DATA_HOME/mimocode` → `$XDG_CONFIG_HOME/mimocode` → `~/.mimocode-junction`)
- Env: `HOME`, `OPENCODE_HOME`, `MIMOCODE_HOME` set to home dir; `MIMOCODE_WORKSPACE_ID` randomized per junction instance
- Polls `/global/health` up to 30 s after URL found
- Shutdown: `SIGTERM` → `SIGKILL` after 5 s

## Session Management

- `POST /session {}` → `{ id }`
- `GET /session` → server session list synced into `knownSessions`; sets active to most recent if current is gone
- `GET /session/{id}/message` for history (returns `[{ info: { role }, parts: [...] }]`)
- Rename: client-side only
- Sessions grouped under `Recent`

## Messaging

- Dual-path streaming:
  - `POST /session/{id}/message { parts, system?, model?, thinking? }` — blocks until done, returns final parts
  - `GET /event` — global SSE stream for real-time deltas (session-gated by `properties.sessionID`)
- SSE stream aborted after POST completes (global `/event` stays open indefinitely otherwise)
- Workspace path injected as `system` on first message per session (`sessionContextInjected` set)
- Token usage extracted from SSE parts → posted as `tokenUsage` on completion
- Abort: `AbortController` on both streams + `POST /session/{id}/abort`

## Model Picker

- Static list: `mimo-auto`, `anthropic/claude-opus-5`, `anthropic/claude-sonnet-4.5`, `openai/gpt-5.2`, `openai/gpt-5.2-mini`, `openai/o4-mini`, `google/gemini-3-pro`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `xiaomi/mimo-v2.5-pro`
- All marked reasoning-capable
- Reasoning: OpenClaw canonical levels

## Auto-Detection

- Config sniffer: reads `<mimoHome>/config.yaml` for `port:` field; probes that port via `GET /global/health` before managed spawn
- Port sniffer: if config sniffer misses, scans common ports (3000, 7080, 8080, 8642, 9000) via `GET /global/health`
- If both miss and `serverUrl` is not set, proceeds to managed spawn
- Rationale: user may have set a fixed port in config but not in extension settings, or port changed while config is stale

## Environment Label

- XDG data dir (`mimocode`) → reads `config.yaml` for `# <agent-name>` comment
- Otherwise: strips `mimocode-` prefix from dir name
