# VSCode Extension Audit — openclaw-vscode v0.2.0

**Audited by:** 灵  
**Date:** 2026-05-31  
**Source:** `/home/e/sauce/ai/bridges/openclaw_vscode/src/`  
**Reference:** `/home/e/sauce/openclaw-src/src/gateway/`  
**Logs:** 4 log files from `~/.config/Code/logs/` + `globalStorage/`

---

## Summary

**15 source files, ~2,500 lines. 4 CRITICAL bugs, 2 HIGH, 4 MEDIUM. The extension has never successfully connected to e's gateway in any logged session.**

The core architecture (connect → sessions → events → display pipeline) is sound. The protocol docs in `agents/PROTOCOL.md` are accurate. But Klaude's drones made systematic param-shape errors on RPC calls — every affected method silently fails with `INVALID_REQUEST`.

---

## CRITICAL Bugs

### BUG #1 — `chat.inject` params mismatch (silent failure)
**File:** `src/gateway/sessionManager.ts:213-218` and `src/ui/chatBase.ts:375`  
**Extension sends:**
```json
{ "sessionKey": "...", "role": "system", "content": "..." }
```
**Gateway expects (`chat.ts:3634`):**
```json
{ "sessionKey": "...", "message": "..." }
```
**Effect:** Workspace context injection silently fails on EVERY message send. The `catch` logs a warning but no context ever reaches the agent. This means the agent has no idea what file/workspace the user is working in.

**Gateway signature:**
```typescript
{ sessionKey: string; message: string; label?: string }
```

---

### BUG #2 — `connect()` resolves `false` but `activate()` treats it as success
**File:** `src/gateway/connection.ts` (connect method) and `src/extension.ts:156-163`

```typescript
// connection.ts: connect() resolves with false on auth failure
.catch((error) => {
    this.logger.error('Failed to authenticate with Gateway', error);
    this.isConnecting = false;
    this.disconnect();
    resolve(false);  // ← returns false, doesn't throw
});

// extension.ts: caller doesn't check return value
await gateway.connect();           // returns false
logger.info('Connected to Gateway'); // ← ALWAYS logs this
await sessionManager.initializeFolderSessions(); // ← proceeds blindly
```

**Effect from logs:** "Connected to Gateway" logged at 23:41:40.968, immediately followed by cascading failures from `initializeFolderSessions`, `tools.effective`, `commands.list`, and `modelManager.getModels` — all failing with "Failed to connect to Gateway" because `isConnected()` returns `false`.

**Fix:** `connect()` must THROW on auth failure. `activate()` should catch and bail out.

---

### BUG #3 — `exec.approval.resolve` params mismatch (approval resolution completely broken)
**File:** `src/utils/messageProcessor.ts:105`  
**Extension sends:**
```json
{ "requestId": "...", "approved": true }
```
**Gateway expects (`exec-approval.ts:446`):**
```json
{ "id": "...", "decision": "allow-once" | "allow-always" | "deny" }
```

**Valid decisions:** `"allow-once"`, `"allow-always"`, `"deny"` (not booleans).

**Effect:** Exec approvals are impossible to resolve. The user clicks Allow/Deny in the modal but the RPC call always fails with `INVALID_REQUEST`.

---

### BUG #4 — `plugin.approval.resolve` params mismatch (same as #3)
**File:** `src/utils/messageProcessor.ts:192`  
**Extension sends:** `{ requestId, approved: true/false }`  
**Gateway expects (`plugin-approval.ts:183`):** `{ id, decision: "allow-once" | "allow-always" | "deny" }`  

**Effect:** Plugin approvals are impossible to resolve.

---

## HIGH Bugs

### BUG #5 — `sessions.usage` missing params validation
**File:** `src/ui/chatBase.ts:358`  
**Extension sends:**
```json
{ "key": sessionKey }
```
**Gateway expects (`usage.ts:838`):**
```typescript
{ key?: string; agentId?: string; startDate?, endDate?, range?, mode?, limit?, utcOffset?, includeContextWeight? }
```

The `key` param is actually optional in the gateway — it accepts it as `p.key`. This might work, but `validateSessionsUsageParams` may expect different field names. **Unverified — needs live test.**

---

### BUG #6 — Activation calls gateway methods before confirming connection
**File:** `src/extension.ts:168-178`

```typescript
// These all fire during activate(), before confirming gateway.isConnected()
const toolStatusManager = new ToolStatusManager();
await registerGatewayTools(context, gateway, toolStatusManager);  // → tools.effective
registerChatParticipant(context, gateway, sessionManager);          // → commands.list
```

**Effect (from logs):** "Requesting tools.effective" → "tools.effective unavailable" at activation time because the gateway isn't connected yet. The misleading error says "gateway build may not support it" when the real cause is "not connected."

These should be deferred until `gateway` emits `'connected'`.

---

## MEDIUM Bugs

### BUG #7 — Misleading error messages
- `toolStatus.ts`: "tools.effective unavailable — gateway build may not support it" — real cause is "not connected"
- `connection.ts`: "Could not find an openclaw.json" for gateway URL — real cause in window2 was that the config was at `~/.ling/` not `~/.openclaw/`

### BUG #8 — Concurrent connect attempts spam
**Files:** `ChatBase` constructor (modelManager, commandPalette, toolStatusManager all try to call methods that trigger connect), `extension.ts` (connect → sessions → tools.effective → commands.list all in parallel)

**Log evidence:** "Connection already in progress" spam when gateway is unreachable.

### BUG #9 — `sessions.create` response field name (cosmetic)
**File:** `src/gateway/folderSessions.ts:158`
```typescript
const childKey: string = childRes?.session?.key || childRes?.key;
```
Gateway returns `{ key, entry }` — `?.session?.key` is always undefined. Falls through to `?.key` which works. The field name should be `?.entry?.key`.

### BUG #10 — `sendRequest` idle timeout may be too low
**File:** `src/gateway/connection.ts:825` (the `sendRequest` method)  
Used with `{ idleTimeoutMs: 15000 }` for `agent` calls. The gateway's `agent.wait` defaults to 30s. If the agent takes >15s to start responding, the request times out even though the agent is working.

---

## Things Klaude Got RIGHT

1. **Protocol version 4** — correct minimum  
2. **`caps: ['tool-events']`** — correct format (top-level, not inside client)  
3. **`sessions.changed` field names** — `sessionKey` (not `key`), `reason` (not `change`)  
4. **`sessions.describe`** — checks `payload.session` not `res.ok`  
5. **`sessions.subscribe` on reconnect** — correct plumbing in `messageProcessor.ts`  
6. **`sessions.messages.subscribe`** — uses `key` not `sessionKey`  
7. **Auth token rotation** — saves `deviceToken` from hello-ok to SecretStorage  
8. **Scope gating** — checks `authScopes` before admin/write calls in `folderSessions.ts`  
9. **PROTOCOL.md** — accurate, well-sourced reference document  
10. **Device auth flow** — correct challenge/nonce/signing pipeline  

---

## Verified Call Cross-Reference

| Method | Extension File | Params | Status |
|--------|---------------|--------|--------|
| `connect` | connection.ts:219 | client, caps, auth, device | ✅ |
| `sessions.subscribe` | messageProcessor.ts:35 | `{}` | ✅ |
| `sessions.describe` | folderSessions.ts:100 | `{ key }` | ✅ |
| `sessions.create` | folderSessions.ts:108,158 | `{ key, label }` / `{ parentSessionKey, label }` | ✅ |
| `sessions.list` | folderSessions.ts:205,381 | `{}` | ✅ |
| `sessions.patch` | sessionManager.ts:199, agentConfig.ts:110 | `{ key, verboseLevel/mode/provider }` | ✅ |
| `sessions.delete` | folderSessions.ts:439 | `{ key }` | ✅ |
| `sessions.reset` | folderSessions.ts:457 | `{ key }` | ✅ |
| `sessions.abort` | agentConfig.ts:155 | `{ key }` | ✅ |
| `sessions.resolve` | folderSessions.ts:417 | `{ label?, agentId? }` | ✅ |
| `sessions.messages.subscribe` | folderSessions.ts:402 | `{ key }` | ✅ |
| `sessions.usage` | chatBase.ts:358 | `{ key }` | ⚠️ unverified |
| `agent` | sessionManager.ts:223, chatParticipant.ts:104 | `{ sessionKey, message, idempotencyKey }` | ✅ |
| `agent.wait` | agentConfig.ts:171 | `{ runId }` | ✅ |
| `chat.history` | sessionManager.ts:253 | `{ sessionKey, limit }` | ✅ |
| `chat.abort` | agentConfig.ts:139 | `{ sessionKey, runId }` | ✅ |
| `chat.inject` | sessionManager.ts:213, chatBase.ts:375 | `{ sessionKey, role, content }` | ❌ **BUG #1** |
| `models.list` | modelManager.ts:78 | `{ view: 'default' }` | ✅ |
| `commands.list` | commandPalette.ts:52 | `{ agentId }` | ✅ |
| `agents.list` | agentConfig.ts:195 | `{}` | ✅ |
| `agent.identity.get` | agentConfig.ts:212 | `{ agentId }` | ✅ |
| `tools.effective` | toolStatus.ts:62 | `{}` | ✅ |
| `tools.catalog` | toolStatus.ts:107 | `{}` | ✅ |
| `exec.approval.resolve` | messageProcessor.ts:105 | `{ requestId, approved }` | ❌ **BUG #3** |
| `plugin.approval.resolve` | messageProcessor.ts:192 | `{ requestId, approved }` | ❌ **BUG #4** |

---

## Recommended Fix Priority

1. **Fix `connect()` return value** (BUG #2) — unblocks all other testing  
2. **Fix `chat.inject` params** (BUG #1) — agent context is broken  
3. **Fix `exec.approval.resolve` / `plugin.approval.resolve` params** (BUGS #3-4) — approval flow completely broken  
4. **Defer methods until connected** (BUG #6) — clean up activation flow  
5. **Fix misleading errors** (BUG #7) — "build may not support" → "not connected"

---

## Current Connection State

The extension currently fails at the device auth step (`DEVICE_AUTH_SIGNATURE_INVALID`). The device needs to be approved on the gateway:

```
OPENCLAW_STATE_DIR='/home/e/.ling' openclaw devices approve
```

Once approved, bugs #2 and #6 will block progress. Fix those first.
