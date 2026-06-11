# UX Decisions Log

Running record of feature decisions during the UX catalog review.

---

## Build status (2026-06-10, Codex transcript parity)

- **Tool action rows (Codex-style):** raw `exec` + JSON cards replaced with humanized rows —
  verb + target + diffstat (`Edited composer.js +12 -3`, `Ran cd …`, `Read file.ts`). Row click
  expands Input/Log/Output detail. Mapping lives in `classifyTool()` (chat-stream.js); kinds:
  `edit | exec | explore | fetch | plan | agent | other`.
- **Turn-end accordions (Codex algorithm):** decompiled the shipped Codex extension's
  `split-items-into-render-groups` bundle and mirrored its activity-slice logic — ALL finished
  activity rows of a turn fold into ONE collapsed `<details>` whose summary aggregates counts
  with unique-path sets: "Edited 2 files, explored 5 files, 3 searches, ran 4 commands"
  (first segment capitalized, rest lowercase; empty → "Tool activity"). Shell commands are
  parsed like Codex's `parsedCmd`: `grep/rg/fd/find` → search, `ls/tree` → list,
  `cat/head/tail/sed -n` → read (counted as exploration, not commands). Running rows and
  non-groupable kinds (plan/agent/other) stay visible at top level. History renders pre-grouped
  + collapsed.
- **Restored tool history:** gateway `chat.history` assistant turns carry
  `{type:'toolCall', id, name, arguments}` content parts with separate `role:'toolResult'`
  messages keyed by `toolCallId`; `rebuildTurnsFromGatewayHistory()` (chatBase.ts) reattaches
  them as `TranscriptTool[]` so reloaded sessions get the same accordions as live runs.
- **Run merging (wall-of-text fix):** OpenClaw stores one agent run as MANY assistant messages
  (`thinking` parts, narration text, toolCalls) — restoring them 1:1 produced a wall of
  reasoning prose. Restore now merges each user→reply cycle into ONE assistant turn:
  `thinking`/`reasoning` parts → collapsed disclosure, toolCalls → activity accordion, prose →
  message text. Verified on a real 558-message session → 36 clean turns.
- **`[[reply_to_current]]` marker:** reasoning-in-text models prefix replies with this OpenClaw
  marker; text before it routes to thinking, after it to content (restore), and live streams
  strip the prefix (`stripReplyMarker`).
- **Raw JSON payloads** in message bodies render as a syntax-highlighted `<pre>` block
  (code-block chrome) instead of markdown-mangled text.
- **Boot chrome (patterns from Codex/Claude Code index.html, no code copied):** template.html
  now ships an inline-styled startup loader (shimmer "Junction" wordmark, reduced-motion
  fallback, paints before module CSS/JS arrive) dismissed by view-router on the first
  switchToHome/switchToChat; a `#boot-error` sentinel `<pre>` fed by window
  `error`/`unhandledrejection` handlers (failure shows text, not a blank panel); a 10s
  watchdog that flips the loader subtitle to "still connecting… is the gateway running?";
  CSP `style-src` gains `'unsafe-inline'` for the boot styles (scripts stay nonce-only,
  same trade-off Claude Code makes).
- **History hygiene:** gateway-restored history drops non `user`/`assistant` roles and bare tool
  echoes ("Successfully replaced N block(s)…" — `TOOL_ECHO_RE` in chatBase.ts). Reasoning
  disclosures in history start collapsed.
- **Throbber fixed:** thinking-bar never started on first render (existingBar short-circuit);
  now starts/reschedules whenever active. Added run-level "Working…" shimmer row (driven by
  `runActive`), suppressed while the thinking bar animates; `prefers-reduced-motion` honored.
- **CSS:** zero hardcoded hex colors in webview CSS (all `--vscode-*` vars; diffstat uses
  `gitDecoration` colors); file-link hover bg uses `color-mix`.
- **Souveraine connection fixed:** bridge-managed `config.toml` was provider-default (bifrost →
  dead `127.0.0.1:3360`); now regenerates with `provider = "openai-oauth"` + `primary_model =
  "gpt-5.5"` when stale, and the spawned server gets `CODEX_HOME` pointing at the real
  `~/.codex` (HOME is isolation-overridden). Verified SSE round-trip.

---

## Build status (2026-06-09, Junction)

Reconciliation of the decisions below against the shipped extension:
- **Built:** session-list home screen, now with **collapsible workspace-aware groups** ("This
  folder" expanded, other folders collapsed) + no-flicker render (Bug 4/5); **auto-naming** new
  chats from the first message (Section 6); per-model **reasoning levels** with an always-on
  OpenClaw-level fallback (Section 4); model picker as a webview choice-menu (not QuickPick);
  env/bridge switcher moved to the **composer footer** bottom-left; full `@vscode/codicons`
  vendored so all glyphs render; lifecycle terminal-phase fix (`end`).
- **Confirmed already correct:** `setSessionModel` sends the combined `provider/model` string
  (the Section 4 "bug to fix" no longer applies).
- **Still deferred (unchanged):** agent picker, session forking, the Codex surfaces listed in the
  re-audit delta of [../ux-audit-codex.md](../ux-audit-codex.md) (editor tabs, hooks/skills/
  computer-use/worktree pages, hotkey window — all Skip/Deferred).
- **Palette commands** (`newChat`/`archive`/`rename`/`back`, "registered, no default bindings"):
  not yet contributed as `junction.*` commands — minor, deferred.

---

## Section 1 — Chat Surface
- **Keep:** Sidebar webview, VS Code chat participant, per-workspace session tree (conversation history)
- **Skip:** Editor tabs, bottom panel, new-window, terminal mode, hotkey popout, thread following, drag-between-locations (VS Code handles sidebar left/right natively)

## Section 2 — Input Composer / File Context

### Selection Tracking Pipeline (Claude-style)
- **Structural diff** — compare `{ filePath, startLine, endLine, startChar, endChar, text }` byte-for-byte. No change = no-op. No timer.
- **Active-editor gate** — only fire for `activeTextEditor`, not all visible editors.
- **Scheme filter** — skip `comment` / `output` virtual documents.
- **Bump-token debounce** — each event gets a unique token. Async work checks staleness before firing. Zero artificial delay.
- **Tab-switch fire** — `onDidChangeActiveTextEditor` updates the live pill immediately.

### Attached Files Bar (above composer)
- **Live selection pill** (first in bar) — toggleable. Auto-updates as cursor/selection changes: `auth.ts` → `auth.ts:10` → `auth.ts:10-25`. ✕ toggles it OFF (dim/hide). Keyboard shortcut or button toggles it back ON.
- **Manual pills** (rest of bar) — one-shot, static. ✕ removes permanently.
- **Right-click "Add to Thread"** on editor selection — adds a selection chip to the bar
- **Right-click "Add File to Thread"** on editor tab — adds a file chip to the bar

### @-Mention Autocomplete
- Type `@` in composer → file/folder autocomplete popup from workspace → inserts as a chip in the bar
- Plain textarea + overlay (no ProseMirror)

### Composer Footer
- Model dropdown (clickable to change)
- File count badge ("3 files attached")

### Send Behavior
- `enter`, `ctrlEnter`, `smartEnter` as setting. Default: `ctrlEnter` (Ctrl/Cmd+Enter sends, Enter inserts newline)

### Rejected (this section)
- Suggestion pills above composer
- Workspace file tree widget in sidebar
- Rich-text composer engine (ProseMirror)
- Send-mode toggle dropdown (use settings)
- Responsive label hiding

## Section 4 — Model Selection

### Bug to Fix
- **`setSessionModel` param mismatch** — `agentConfig.ts` sends `{ key, provider, model }` but gateway expects `{ key, model: "provider/model-id" }` as a single string. Currently silently fails every time.

### Model Caching (adopt gateway `GatewayModelCatalogCache` pattern)
- Stale-while-revalidate — return cached data immediately, refresh in background on staleness
- In-flight dedup — concurrent `models.list` requests share one promise
- Generation-counter invalidation — mark stale on reconnect, not manual `null` assignment
- Load on connect — populate cache in `connected` event handler, not on user click
- Error fallback — return stale cache + log warning (never show empty state if cache exists)
- Push current model name to webview on connect (not just "Model")

### Model Picker
- Dropdown in composer footer — shows current model, clickable → VS Code QuickPick
- Grouped by provider (use gateway's native `models.list` response structure)
- On select: `sessions.patch({ key, model: "provider/id" })` with `operator.admin` scope
- Scope fallback: if no admin scope, use `agent({ provider, model })` per-request (OpenClaw native fallback, nothing invented)

### Thinking Level (nested under model)
- OpenClaw thinking levels are per-model — each model advertises whether it supports reasoning via `capabilities.reasoning`
- Flow: user picks a model → if model has reasoning capabilities → second QuickPick appears: "Thinking level for {model}" → list available levels → select → patch both model + thinking together
- If model has no reasoning capability: skip thinking picker, apply model directly
- Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max` (not all available for every model — gateway validates)
- Set via `sessions.patch({ key, model: "provider/id", thinkingLevel })` in a single call (batch the patch)
- Fallback: per-request `agent({ model, provider, thinking })` when no admin scope

### Deferred
- Agent picker (`agents.list` → QuickPick with agent identity)

## Section 6 — Sessions & Conversations

### UX Model: Session List as Home Screen
- Sidebar shows session list by default (home screen)
- Clicking a session opens that chat
- "←" back button in chat header returns to session list
- Typing a message from home screen auto-creates a new chat session
- "+ New" button in top-right of session list header

### Smart Reopen
- On extension activate: if there was an active session → open directly to chat view
- Fresh start / no prior session → show session list
- State persisted per workspace folder

### Session Actions
| Action | How | API |
|--------|-----|-----|
| Resume | Click session in list | N/A (UI navigation) |
| New chat | [+] button or type in input | `sessions.create({ parentSessionKey })` |
| Archive | Right-click → Archive | UI only — hides from list in workspace state. Does NOT call `sessions.delete` |
| Rename | Right-click → Rename or click title | `sessions.patch({ label })` |

### Auto-Naming
- New conversations auto-titled from first message content
- Editable via rename

### Keyboard Shortcuts (registered, NO default bindings)
- `openclaw.newChat`
- `openclaw.archiveSession`
- `openclaw.renameSession`
- `openclaw.backToSessionList`

### Rejected
- Delete (replaced with archive — UI-level hide only)
- Fork (no general API — deferred)
- Teleport (no API)
- Hidden sessions (deferred)
- Tab-based conversations (sidebar only)
- Opaque keyboard shortcuts (all unbound)
