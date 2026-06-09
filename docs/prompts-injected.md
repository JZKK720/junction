# OpenClaw VSCode Extension — Injected Prompts

All text the extension injects into agent context. Every injection point, its content, and when it fires.

---

## 1. Workspace Context (chat.inject)

**File:** `src/gateway/sessionManager.ts:207-215`  
**Trigger:** First `agent` message sent per session (guarded by `injectedSessions` set)  
**Scope required:** `operator.admin` (silently skipped otherwise)

```
This session is driven from the VS Code extension.
The user is working in: <workspace_folder_path>
When file paths are mentioned, treat them as relative to that workspace unless they are absolute.
```

---

## 2. File Context (chat.inject)

**File:** `src/ui/chatBase.ts:375`  
**Trigger:** On every message send, when `gateway.getPendingFileContext()` returns non-null  
**Scope required:** `operator.admin` (falls back to text prepend otherwise)

```
[Workspace File Context]
Current file: <file_path>

Selected code:
```<language>
<selection_text>
```
```

---

## 3. verboseLevel (sessions.patch)

**File:** `src/gateway/sessionManager.ts:199` and `src/ui/chatParticipant.ts:64`  
**Trigger:** Every `agent` message send  
**Scope required:** `operator.admin`

```json
{ "key": "<sessionKey>", "verboseLevel": "on" }
```

Not text injected into the agent — it enables verbose tool event streaming so the extension can render tool cards.

---

## 4. Agent Message (agent method)

**File:** `src/gateway/sessionManager.ts:224` (chat panel) and `src/ui/chatParticipant.ts:104` (VS Code chat)  
**Trigger:** Every user message

```json
{
  "sessionKey": "<sessionKey>",
  "message": "<user_text>",
  "idempotencyKey": "<uuid>"
}
```

**Chat participant variant** (via `buildAgentParams` in `src/gateway/agentConfig.ts:60`):

```json
{
  "sessionKey": "<sessionKey>",
  "message": "<context_header>\n<user_prompt>",
  "idempotencyKey": "<uuid>",
  "model": "<selected_model>"        // optional, when user picks a model
}
```

The context header is built from the active editor and workspace:

```
Workspace: <workspace_path> | Active file: <file_name>

<user_prompt>
```

---

## 5. File Context Fallback (text prepend)

**File:** `src/ui/chatBase.ts:378-381`  
**Trigger:** When `chat.inject` fails (no `operator.admin` scope)  
**Scope:** Any (prepends to message text)

```
<file_context>

<user_message>
```

---

## 6. Language Model Provider (lmProvider.ts)

**File:** `src/gateway/lmProvider.ts:108`  
**Trigger:** When VS Code LM API routes a request through the gateway provider

```json
{
  "sessionKey": "<sessionKey>",
  "message": "<converted_prompt>",
  "idempotencyKey": "lm-<timestamp>",
  "model": "<model_id>"
}
```

---

## Summary

| # | Method | Injected Text | Scope |
|---|--------|--------------|-------|
| 1 | `chat.inject` | "This session is driven from the VS Code extension. The user is working in: {path}" | `operator.admin` |
| 2 | `chat.inject` | "[Workspace File Context]\nCurrent file: {path}\n\nSelected code: ..." | `operator.admin` |
| 3 | `sessions.patch` | `{ verboseLevel: 'on' }` | `operator.admin` |
| 4 | `agent` | `{ message: user_text, idempotencyKey, model? }` | `operator.write` |
| 5 | text prepend | "{file_context}\n\n{user_message}" | any (fallback) |
| 6 | `agent` (LM API) | `{ message: prompt, model }` | `operator.write` |
