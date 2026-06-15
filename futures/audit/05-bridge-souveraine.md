# Souveraine Bridge

**Protocol:** REST + SSE streaming  
**Capabilities:** sessions ✓ · models ✓ · agents ✓ · steering ✓ · usage ✗ · tools ✓

## Connection

- REST base URL: `junction.souveraine.baseUrl` (default `http://127.0.0.1:8484`)
- `isConnected()` always returns `true` (stateless HTTP; health checked at connect time)
- Sessions and active conversation ID persisted in `workspaceState`

## Managed Runtime Spawn

- Writes bridge-managed `config.toml` to `<souveraineHome>/.souveraine/config.toml` if missing or stale
- Config: loopback bind, port 8484, `openai-oauth` provider pointing at `http://127.0.0.1:3360` (Codex CLI bifrost)
- Spawn: `cargo run --release --manifest-path <repo>/Cargo.toml -- server --bind 127.0.0.1 --port 8484`
- `HOME` overridden to `souveraineHome` for state isolation
- `CODEX_HOME` set to real Codex CLI auth dir (`~/.codex`)
- `CARGO_HOME` and `RUSTUP_HOME` pointed back at real home
- Requires `junction.souveraine.repoPath` set; no-op if empty
- Polls `/health` up to 45 s

## Agent Provisioning

- Looks for existing agent named `souvieling` via `GET /v1/agents`
- If not found: creates it with:
  - `llm_config`: model `openai/kimi-k2.6`, context_window 128000, max_tool_rounds 10
  - `memory_blocks`: `agents` (from `AGENTS.md`), `soul` (from `SOUL_INCARNATION.md` with `{harness}` → `Souveraine`)
  - `tags`: `[junction, ling, incarnation, souvieling]`
- Identity files read from `~/entities/ling/workspace-灵/`

## Session Management

- `POST /v1/conversations { agent_id }` → `{ id }`
- `GET /v1/conversations/{id}/messages` for history
- Rename: client-side only
- Sessions grouped under `Recent`

## Messaging

- `POST /v1/conversations/{id}/messages` with `stream: true` → SSE
- Abort: `AbortController` on active SSE request
- Workspace context prepended to message text if present

## Model Picker

- Static list: `openai/kimi-k2.6`, `openai/deepseek-v4-pro`
- Both reasoning-capable
- Reasoning: OpenClaw canonical levels (`off minimal low medium high`) as per-request only

## Steering

- `POST /v1/conversations/{id}/interject { text }` — server-side WIP

## Auto-Detection

- Port sniffer: checks ports 8484, 8080, 8000, 9000; matches on `GET /v1/agents` returning an array
- Config sniffer: reads `<souveraineHome>/.souveraine/config.toml`; extracts `port =` under `[server]` block; probes that port first before scanning known ports
- Rationale: user may have changed port but left config.toml intact, or vice versa; both paths tried in sequence

## Environment Label

- Derived from `souveraineHome` dir name (strips `souveraine-` prefix, strips `-home` suffix)
