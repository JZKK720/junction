# Reconciled Queue — Junction

## Phase 2 — JSONL Pagination Fixes (2026-06-12)

### Changes made

**`src/gateway/sessionManager.ts`**
- Deleted dead `sessions.get` request (result was unused)
- Changed `getSessionHistoryFromJsonl` signature: `sessionId` → `sessionKey`
- Resolves session via `sessions.list` to get `sessionId` + `agentId` (no hardcoded `main`)
- Fixed overlapping windows: `readEnd = fileSize - offset` (was always `fileSize`)
- Fixed truncated boundary line: skips to first newline when `readStart > 0`
- Non-progress guard: if `nextOffset` doesn't advance, returns hasMore=false
- Removed `messages.reverse()` — JSONL lines are already chronological
- Removed unused `os` import

**`src/ui/chatBase.ts`**
- Deleted dead `_sessionId` field (declared, never assigned)
- `handleLoadMoreHistoryFromJsonl`: uses `getCurrentSessionKey()` instead of `_sessionId`
- Falls back to gateway `handleLoadMoreHistory()` when JSONL unavailable (instead of `noMoreHistory`)

**`src/bridges/openclaw/OpenClawBridge.ts`**
- Updated `getSessionHistoryFromJsonl` param name: `sessionId` → `sessionKey`

**`src/bridges/types.ts`**
- Updated `getSessionHistoryFromJsonl` interface signature: `sessionId` → `sessionKey`

**`src/types/openclaw.d.ts`**
- Added optional `sessionId` field to `SessionEntry`

**`resources/webview/chat-stream.js`**
- `moreHistory` handler: wraps row creation in `isRestoringHistory = true/false` to suppress rise-up animation and forceScroll
- Uses `baseIndex = _jsonlOffset + index` for unique runIds across pages (prevents `activeRuns`/`toolContainers` collision)

### Verification
- `npm test` green (tsc + bridge-protocol tests)
- No stale `_sessionId` references
- No `sessions.get` dead code remaining

### Notes for live testing
- No JSONL files existed under `~/.openclaw` on this machine at time of implementation
- Needs dev host testing against real OpenClaw session with `showFullHistory` on
- Temporarily pass tiny `maxBytes` (~4KB) to force multi-page
- Verify: page 2 ≠ page 1, chronological order, rows prepend on top, scroll stays put, unresolvable JSONL path falls back to gateway history

### Found during phase 2
- The `addAssistantHistoryRow` function's runId pattern (`'history:' + index`) collides when loading multiple pages — fixed at caller level with `baseIndex`
