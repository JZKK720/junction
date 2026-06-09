# UX Decisions Log

Running record of feature decisions during the UX catalog review.

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
