# OpenClaw Session Lifecycle API Audit

**Source:** `~/sauce/openclaw-src` — custom build  
**Audit date:** 2026-05-31  
**Scope:** Session forking, teleporting, checkpoint/restore, archiving, renaming

---

## 1. Session Forking

### Verdict: PARTIALLY SUPPORTED — but no general-purpose `sessions.fork` RPC

OpenClaw has an internal fork mechanism, but it is purpose-built for subagent spawning. There is **no public RPC to fork an arbitrary session at an arbitrary message.**

### What exists:

| Feature | API / Code Path | Details |
|---|---|---|
| **Subagent transcript fork** | `sessions_spawn(context="fork")` | Forks the requester's transcript when spawning a native subagent. The child gets a copy of the parent's transcript lines, trimmed to the current leaf. |
| **`sessions.create` with `parentSessionKey`** | RPC: `sessions.create` | Sets a parent-child link (`parentSessionKey` field) but does **NOT** copy/fork history. It's a lineage/metadata relationship only. |
| **`forkedFromParent` flag** | `SessionEntry.forkedFromParent: boolean` | Set to `true` when a session was created by forking a parent transcript. Used in `sessions.changed` broadcast payload. |
| **Internal fork function** | `auto-reply/reply/session-fork.ts` → `forkSessionFromParent()` | Copies parent transcript JSONL line-by-line into a new session file. Only invoked internally during `sessions_spawn(context="fork")`. |
| **Parent fork size guard** | `DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000` | If the parent transcript exceeds ~100K tokens, the fork is skipped and the child starts isolated. |

### What is missing:

- **No `sessions.fork` RPC method.** You cannot call `sessions.fork` with a session key and message index to branch a session.
- **No message-level branching.** Forking always grabs the full parent transcript up to the current leaf. No ability to fork at message #N.
- **No user-facing "fork this session" command.** Forks are only initiated programmatically via `sessions_spawn`.

### Key source files:
```
src/gateway/server-methods/sessions.ts          — sessions.create (parentSessionKey), sessions.spawn handling
src/auto-reply/reply/session-fork.ts            — forkSessionFromParent(), resolveParentForkDecision()
src/agents/subagent-spawn.ts                     — forks transcript for context="fork" children
src/agents/tools/sessions-spawn-tool.ts          — sessions_spawn tool definition
src/config/sessions/types.ts                     — SessionEntry.forkedFromParent
```

---

## 2. Session Teleporting / Rewinding

### Verdict: NOT SUPPORTED

There is **no mechanism to jump or rewind a session to a specific point in its history.** The concept does not exist in the codebase.

### What was searched:

| Term | Results |
|---|---|
| `teleport` | 0 matches in gateway source |
| `rewind` | 0 matches in gateway source |
| `seekTo` / `jumpTo` | 0 matches |
| `position` in sessions.patch | Only used for file-position reads in `session-compaction-checkpoints.ts` (reading transcript bytes); not a session pointer |
| `messageIndex` / `message_index` | 0 matches |
| `sessions.patch` params | Only supports label, model, thinkingLevel, fastMode, verboseLevel, traceLevel, reasoningLevel, responseUsage, elevatedLevel, execHost, execSecurity, execAsk, execNode, sendPolicy, groupActivation, and subagent lineage fields. **No position/rewind fields.** |

### Alternatives that achieve a similar effect:

- **`sessions.compaction.restore`** — restores a session to a previous compaction checkpoint (see §3), which effectively rewinds the session to a prior state but **overwrites the current session** rather than teleporting within it.
- **`sessions.reset`** — creates a fresh sessionId while preserving config-level state (model, thinking level, etc.) — this is a "new conversation" button, not teleporting.

### Key schema: `SessionsPatchParamsSchema`

```typescript
// src/gateway/protocol/schema/sessions.ts
export const SessionsPatchParamsSchema = Type.Object({
  key: NonEmptyString,
  label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
  thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  fastMode: ...,
  verboseLevel: ...,
  traceLevel: ...,
  reasoningLevel: ...,
  responseUsage: ...,
  elevatedLevel: ...,
  execHost: ...,
  execSecurity: ...,
  execAsk: ...,
  execNode: ...,
  model: ...,
  spawnedBy: ...,
  spawnedWorkspaceDir: ...,
  spawnDepth: ...,
  subagentRole: ...,
  subagentControlScope: ...,
  inheritedToolAllow: ...,
  inheritedToolDeny: ...,
  sendPolicy: ...,
  groupActivation: ...,
  // NOTE: No messageIndex, position, seekTo, currentMessage, or teleport params
});
```

---

## 3. Checkpoint / Restore

### Verdict: SUPPORTED — but limited to compaction checkpoints

OpenClaw has a compaction-checkpoint-based branch/restore system. It is **not** a general-purpose checkpoint system; checkpoints are only created during session compaction.

### Available RPC methods:

| Method | Params | Behavior |
|---|---|---|
| `sessions.compaction.list` | `{ key }` | Returns all compaction checkpoints for a session, sorted newest-first |
| `sessions.compaction.get` | `{ key, checkpointId }` | Returns a single checkpoint by ID |
| `sessions.compaction.branch` | `{ key, checkpointId }` | Creates a **new** session from a checkpoint. The original session is untouched. New session has `parentSessionKey` set and label appended with " (checkpoint)". |
| `sessions.compaction.restore` | `{ key, checkpointId }` | **Overwrites** the current session with the checkpoint state. Interrupts any active run first. Preserves compaction checkpoints across the restore so you can restore again to an earlier point. |

### Checkpoint structure:

```typescript
// src/gateway/protocol/schema/sessions.ts
SessionCompactionCheckpoint {
  checkpointId: string       // UUID
  sessionKey: string
  sessionId: string
  createdAt: number          // epoch ms
  reason: "manual" | "auto-threshold" | "overflow-retry" | "timeout-retry"
  tokensBefore?: number
  tokensAfter?: number
  summary?: string
  firstKeptEntryId?: string
  preCompaction: {
    sessionId: string
    sessionFile?: string     // pre-compaction transcript snapshot
    leafId: string           // entry ID marking the fork point
  }
  postCompaction: {
    sessionId: string
    sessionFile?: string     // compacted transcript (used as fork source if preCompaction file is missing)
    leafId?: string
    entryId?: string
  }
}
```

### Limitations:

| Limit | Value |
|---|---|
| Max checkpoints per session | 25 |
| Max retained snapshot bytes per session | 128 MB |
| Max leaf scan bytes (finding fork point) | 64 MB |
| Checkpoint trigger | Only during compaction (auto-threshold, overflow-retry, timeout-retry, or manual) |
| No arbitrary checkpoints | Cannot snapshot a session mid-conversation on demand |
| No cross-session restore | `restore` works only on the source session; `branch` creates a new one |

### How branching works internally (`forkCompactionCheckpointTranscriptAsync`):

1. Reads the pre-compaction transcript file (or falls back to post-compaction)
2. Parses JSONL entries
3. Migrates entries to current schema version
4. Trims to the `leafId` (the last entry before compaction)
5. Writes a new `.jsonl` file with a fresh session header and `parentSession` field
6. Creates a new `SessionEntry` in the store with `parentSessionKey`, `forkedFromParent`, and token estimate

### Key source files:
```
src/gateway/session-compaction-checkpoints.ts  — forkCompactionCheckpointTranscriptAsync(), persistSessionCompactionCheckpoint()
src/gateway/server-methods/sessions.ts          — sessions.compaction.branch, sessions.compaction.restore handlers
src/gateway/protocol/schema/sessions.ts         — compaction schemas
```

---

## 4. Session Archiving

### Verdict: SUPPORTED — soft-delete with archive distinction

OpenClaw uses **soft archiving** for session transcripts during delete and reset operations.

### `sessions.delete` response shape:

```json
{
  "ok": true,
  "key": "agent:main:main",    // canonical session key
  "deleted": true,             // whether the store entry was removed
  "archived": [                // array of archived transcript file paths
    "/path/to/sessions/<id>.jsonl.deleted.2026-05-31T17-00-00Z"
  ]
}
```

### What archiving does:

- **Store entry:** Hard-deleted from the session store JSON (removed from the `Record<string, SessionEntry>`)
- **Transcript files:** Renamed to `<original>.jsonl.deleted.<iso-timestamp>` via `fs.renameSync()` — **not** actually deleted
- **Multi-candidate resolution:** `archiveSessionTranscriptsDetailed()` resolves all possible transcript paths (store directory, agent directory, legacy dir) and archives every file that exists
- **Cleanup:** `cleanupArchivedSessionTranscripts()` runs periodic cleanup of archive files older than a threshold

### `sessions.delete` params:

```typescript
SessionsDeleteParamsSchema = {
  key: string,                    // required
  deleteTranscript: boolean,      // default: true — set false to skip transcript archival
  emitLifecycleHooks: boolean,    // default: true — set false to skip hook emission
}
```

### Archiving also happens during:

| Operation | Archive suffix |
|---|---|
| `sessions.delete` | `.jsonl.deleted.<ts>` |
| `sessions.reset` (via `/new`) | `.jsonl.reset.<ts>` |
| `sessions.compact` (maxLines mode) | `.jsonl.bak.<ts>` |

### Archive vs. delete distinction:

| Aspect | Store Entry | Transcript Files |
|---|---|---|
| `sessions.delete` | Hard-removed from store | Archived (renamed with `.deleted.` suffix) |
| `sessions.delete` with `deleteTranscript: false` | Hard-removed from store | Left untouched on disk |
| `sessions.reset` | Replaced with new entry | Previous transcript archived (`.reset.` suffix) |
| Recovery | No built-in un-delete RPC | Files remain on disk until cleanup |

### Key source files:
```
src/gateway/session-transcript-files.fs.ts   — archiveFileOnDisk(), archiveSessionTranscripts(), resolveSessionTranscriptCandidates()
src/gateway/server-methods/sessions.ts        — sessions.delete handler
src/gateway/session-reset-service.ts          — archiveSessionTranscriptsForSession()
src/gateway/session-archive.fs.ts             — re-exports from session-transcript-files.fs.ts
```

---

## 5. Session Renaming

### Verdict: SUPPORTED via `sessions.patch`

Sessions can be renamed using the `sessions.patch` RPC with the `label` field.

### Usage:

```json
// Set a label:
{ "method": "sessions.patch", "params": { "key": "agent:main:main", "label": "My Project" } }

// Clear a label:
{ "method": "sessions.patch", "params": { "key": "agent:main:main", "label": null } }
```

### Validation rules (from `sessions-patch.ts`):

- Labels are validated via `parseSessionLabel()` — must be a non-empty string with constraints
- Labels must be **unique within the store** — duplicate labels are rejected with `"label already in use"`
- Setting `label: null` clears the label
- `SessionLabelString` is a validated string type (not arbitrary — checked against session label rules)
- Labels with leading/trailing whitespace are trimmed
- `sessions.create` also accepts a `label` parameter for setting at creation time

### Key source files:
```
src/gateway/sessions-patch.ts                 — applySessionsPatchToStore() label handling
src/gateway/protocol/schema/sessions.ts       — SessionsPatchParamsSchema.label
src/sessions/session-label.ts                 — parseSessionLabel() validation
```

---

## Summary Matrix

| Feature | Status | Method(s) | Key limitation |
|---|---|---|---|
| Fork session at arbitrary message | ❌ None | — | Only works for subagent spawns |
| Fork from compaction checkpoint | ✅ Supported | `sessions.compaction.branch` | Only from compaction checkpoints |
| Teleport/rewind within session | ❌ None | — | No concept exists |
| Restore session to checkpoint | ✅ Supported | `sessions.compaction.restore` | Overwrites; only from compaction checkpoints |
| Archive on delete | ✅ Supported | `sessions.delete` | Soft archive (rename, not rm) |
| Archive on reset | ✅ Supported | `sessions.reset` | `.reset.` suffix |
| Rename session | ✅ Supported | `sessions.patch { label }` | Labels must be unique |
| Delete session | ✅ Supported | `sessions.delete` | Hard store delete, soft transcript archive |
| List archives | ❌ None | — | No API; fs-level only |
| Recover archived session | ❌ None | — | Would need manual fs operations |

---

## What Would Need to Be Built

### For general session forking at message #N:
1. New RPC: `sessions.fork` with params `{ key, messageIndex }`
2. New logic: read transcript up to `messageIndex`, write as new session file
3. Could reuse `forkCompactionCheckpointTranscriptAsync()` pattern (reads entries, trims, writes new file)

### For session teleporting/rewinding:
1. New RPC: `sessions.teleport` with params `{ key, messageIndex }`
2. Or add `messageIndex` to `sessions.patch` schema
3. Logic: truncate transcript at message #N, update session entry
4. Need to handle edge cases: active runs, subagent children, compaction checkpoints

### For arbitrary manual checkpoints:
1. New RPC: `sessions.checkpoint.create` with params `{ key, label? }`
2. Reuse `forkCompactionCheckpointTranscriptAsync()` to snapshot current transcript
3. Store as a `SessionCompactionCheckpoint` (or new checkpoint type)
4. Extend `branch` and `restore` to work on manual checkpoints

### For archive recovery:
1. New RPC: `sessions.restore` (different from `compaction.restore`) or `sessions.recover`
2. Scan archive directory for `.deleted.<ts>` files matching a session ID
3. Rename back to original `.jsonl` and recreate store entry
