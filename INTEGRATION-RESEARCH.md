# Integration Research: Adding MiMoCode as a New Junction Backend

**Date:** 2026-06-13
**Sources:** Junction source at `/home/e/sauce/ai/bridges/openclaw_vscode/`; MiMoCode SDK at `/home/e/sauce/ai/agents/mimo-code/packages/sdk/js/src/`; existing audit at `AUDIT-REPORT-FOR-JUNCTION.md`

---

## 1. The `ChatBridge` Interface (EXACT Definition)

Source: `src/bridges/types.ts:90-130`

```typescript
export interface ChatBridge extends EventEmitter {
    readonly id: BridgeId;               // unique string key ("openclaw" | "hermes" | "souveraine" | string)
    readonly label: string;               // human display name ("OpenClaw")
    readonly context: vscode.ExtensionContext;
    readonly capabilities: BridgeCapabilities;

    // ── Lifecycle ──
    connect(): Promise<boolean>;
    disconnect(): void;
    isConnected(): boolean;
    initializeWorkspace(): Promise<void>;
    registerRuntimeIntegrations(): Promise<void>;
    configure(): Promise<void>;
    getSettingsQuery(): string;

    // ── File context ──
    setPendingFileContext(context: string): void;
    getPendingFileContext(): string | null;

    // ── Session management ──
    getCurrentSessionKey(folderUri?: vscode.Uri): string | null;
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri>;
    setActiveSession(folderUri: vscode.Uri, key: string): void;
    watchSession?(key: string): void;        // optional — for shared-gateway bridges
    unwatchSession?(key: string): void;      // optional
    createChat(folderUri?: vscode.Uri): Promise<string>;
    listSessions(scope: ChatScope, includeArchived: boolean,
                 archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]>;
    renameSession(key: string, label: string): Promise<void>;
    getSessionHistory(limit?: number, folderUri?: vscode.Uri): Promise<any>;
    getSessionHistoryFromJsonl?(sessionKey: string, offset?: number,
                                 maxBytes?: number): Promise<any>;

    // ── Messaging ──
    sendChatMessage(message: string, context?: BridgeContext): Promise<any>;
    stopRun(sessionKey: string, runId?: string): Promise<void>;
    getUsage(sessionKey: string): Promise<any>;
    injectMessage(sessionKey: string, message: string): Promise<boolean>;
    canSteer(): boolean;
    canAdminInject(): boolean;

    // ── Model / Agent selection ──
    setSelection(selection: BridgeSelectionState): void;
    listModelChoices(selectedModel?: string,
                     selectedThinking?: string): Promise<ModelChoice[]>;
    selectModelChoice(data: any, sessionKey?: string | null):
        Promise<{ display: string; modelId: string; thinking?: string;
                  perRequestOnly?: boolean } | null>;

    // ── Environment / agent picker ──
    listEnvironmentChoices(): Promise<ChoiceMenuItem[]>;
    selectEnvironmentChoice(data: any): Promise<void>;
    getEnvironmentLabel(): string;

    // ── Slash commands / tool status ──
    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }>;
    getToolStatus(): ToolStatusView | null;
}
```

Related types (`types.ts:1-89`):

```typescript
export type BridgeId = 'openclaw' | 'hermes' | 'souveraine' | (string & {});
export type ChatScope = 'folder' | 'all';

export const OPENCLAW_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

export interface BridgeCapabilities {
    sessions: boolean;
    models: boolean;
    agents: boolean;
    steering: boolean;
    usage: boolean;
    tools: boolean;
}

export interface BridgeSession {
    key: string; title: string; model?: string;
    isActive?: boolean; isArchived?: boolean;
    groupId?: string; groupLabel?: string;
    isCurrentGroup?: boolean; lastActiveTs?: number; messageCount?: number;
}

export interface ModelChoice extends ChoiceMenuItem {
    provider?: string; model?: string; supportsReasoning?: boolean; thinking?: string;
}

export interface BridgeSelectionState {
    modelId?: string; thinking?: string; agentId?: string;
}
```

---

## 2. Bridge Lifecycle

### 2.1 Creation

Bridges are **registered at extension startup** in `ChatViewProvider`'s constructor.

**File:** `src/ui/chatViewProvider.ts:13-20`

```typescript
const registry = new BridgeRegistry(context);
const instanceId = `junction-${crypto.randomUUID()}`;
registry.register(new OpenClawBridge(context, instanceId));
registry.register(new HermesBridge(context));
registry.register(new SouveraineBridge(context));
```

### 2.2 Connection

After registration, the extension calls `bridgeRegistry.connectActive()` (`src/extension.ts:78`):

```
init → registry.register(bridge)
     → registry.connectActive()       // calls this.active.connect()
          → bridge.connect()
          → bridge.registerRuntimeIntegrations()
```

`connect()` is called:
1. On extension activation (`extension.ts:78`)
2. When the user switches bridges via the environment picker (`registry.ts:34`)
3. When the user configures a bridge via `configure()` (e.g., after changing URL)
4. When the webview sends `initRequest` / `ready` (`chatBase.ts:275` — `handleInitRequest()`)

### 2.3 Active Bridge Switching

When the user selects a different bridge (`BridgeRegistry.setActive(id)`, `registry.ts:28-38`):

```
setActive(id)
  → this.active.disconnect()
  → emit('changed', newBridge)
  → ChatBase handler:
      → clears all transcript/cachedHistory
      → postMessage({ type: 'clearChat' })
      → calls handleInitRequest()
```

### 2.4 Message Flow

```
User types in webview composer
  → vscode.postMessage({ type: 'sendMessage', text, dispatchOverride })
  → EventRouter.handleMessage()            (src/ui/event-router.ts)
  → ChatBase.handleUserMessage()           (chatBase.ts)
  → ChatBase.dispatchUserMessage()         (chatBase.ts)
  → bridge.sendChatMessage(text, context)  ⬅️ YOUR BRIDGE METHOD
  → Bridge emits 'stream' events
  → ChatBase.handleStreamEvent()           (chatBase.ts)
  → postToWebview() messages               (chat-stream.js receives them)
```

### 2.5 Stream Events

During `sendChatMessage()`, the bridge must emit `EventEmitter` `'stream'` events. These are consumed by `ChatBase.attachBridgeStreamListener()` (`chatBase.ts:102-109`). The key event types that `chat-stream.js` renders:

| `stream.type` | When | Webview Message Type |
|---|---|---|
| `agent_lifecycle` (phase=start) | Run begins | `runActive` |
| `agent_message` | Text delta | `assistant_stream_delta` |
| `thinking_chunk` | Reasoning text | `thinking_chunk` |
| `tool_event` (phase=start) | Tool call begins | `tool_start` |
| `tool_event` (phase=update) | Tool progress | `tool_update` |
| `tool_event` (phase=result) | Tool completes | `tool_result` |
| `agent_lifecycle` (phase=completed) | Run ends | `assistant_stream_end` |
| `agent_lifecycle` (phase=cancelled) | Run cancelled | — |
| `agent_lifecycle` (phase=error) | Run errored | — |

### 2.6 Destruction

`deactivate()` in `extension.ts` doesn't explicitly disconnect bridges — they're GC'd with the extension. The `chatViewProvider` and its registry go out of scope when the extension host shuts down.

For testing/lifecycle: `bridgeRegistry.disconnectAll()` is available (`registry.ts:41-43`).

---

## 3. Session Awareness

### 3.1 Session Key Model

Each bridge manages its own session key. The key is a string identifier like `"session-abc123"`.

- **OpenClawBridge** (`OpenClawBridge.ts:140-142`):
  Delegates to `SessionManager`, which gets the key from the gateway via `sessions.current` or tracks it in workspaceState.

- **HermesBridge** (`HermesBridge.ts:161-163`):
  Stores `activeSessionId` in `context.workspaceState` (persists across VSCode restarts).

- **SouveraineBridge** (`SouveraineBridge.ts:124-126`):
  Stores `activeConversationId` in `context.workspaceState`.

### 3.2 Session Persistence

Each bridge persists sessions differently:

| Bridge | Storage | What's Stored |
|---|---|---|
| OpenClaw | Gateway-managed (server-side) + client-side `workspaceState` | Session key, folder bindings |
| Hermes | `workspaceState` (`junction.hermes.knownSessions`, `junction.hermes.activeSessionId`) | Session keys, titles, model selection |
| Souveraine | `workspaceState` (`junction.souveraine.knownConversations`, `junction.souveraine.activeConversationId`) | Conversation keys, titles, model selection |

### 3.3 Transcript Persistence

Junction keeps TWO layers:

1. **In-memory cache** (`chatBase.ts`): `sessionTranscripts: Map<string, TranscriptTurn[]>` — keyed by session key, holds the current transcript turns.

2. **History loading** via `getSessionHistory()` (`history-manager.ts:155-174`):
   ```
   handleInitRequest()/handleResumeSession()
     → historyManager.restoreHistory(bridge, transcript, onTurns)
       → bridge.getSessionHistory(limit)
         → Shape expected: { messages: Array<{ role, content, ... }> }
     → rebuildTurnsFromGatewayHistory(messages)
   ```

### 3.4 Session List

Sessions are listed via `bridge.listSessions(scope, includeArchived, archivedKeys)` which returns `BridgeSession[]`. The `HistoryManager.buildSessionGroups()` partitions them by `groupId` into collapsible groups.

### 3.5 How Different Session Models Work

**OpenClaw's model** (`OpenClawBridge.ts:161-198`): Gateway-managed. Sessions are server-side resources. `listSessions()` calls `sessions.list` gateway method. Folder bindings are tracked via `SessionManager.getSessionToFolder()` — a `Map<string, vscode.Uri>`.

**Hermes's model** (`HermesBridge.ts:175-192`): Client-side only. Sessions are stored in `workspaceState` as a `Map`. `listSessions()` returns only known sessions. History is not persisted server-side (`getSessionHistory()` returns empty).

**Souveraine's model** (`SouveraineBridge.ts:141-163`): Client-side session list (same as Hermes), but history is fetched from the server via `GET /v1/conversations/{id}/messages`.

---

## 4. What Would Need to Change for MiMoCode

### 4.1 Session Model Mapping

MiMoCode has its own session model — server-side sessions with a rich REST API (`@mimo-ai/sdk`):
- `POST /session` — create session
- `GET /session/:id/message` — get messages
- `POST /session/:id/message` — send prompt (sync/streaming)
- `DELETE /session/:id` — delete
- `POST /session/:id/abort` — cancel
- `GET /session` — list sessions

**Challenge:** MiMoCode sessions are tied to a `directory` (workspace root), not a VSCode folder URI. The bridge needs to maintain a mapping from `vscode.Uri` (workspace folder) → MiMoCode session ID.

**Challenge:** MiMoCode session IDs are UUIDs (like `"clx1234..."`). The `groupBy` model (folder bindings) needs MiMoCode sessions grouped by workspace directory.

**Challenge:** MiMoCode uses `x-mimocode-directory` header for scoping. `listSessions` needs `?directory=` or the header.

### 4.2 Event/Stream Mapping

MiMoCode's SSE `/event` endpoint emits events in a different shape than Junction's stream events:

| MiMoCode SSE Event Type | Junction stream type | Mapping |
|---|---|---|
| `message.updated` (new assistant message with parts) | `agent_message` (text), `thinking_chunk` (reasoning) | Parse `parts[]` to extract text, reasoning, tool calls |
| `message.removed` | — | Session cleanup |
| `event: tool.execute.before` | `tool_event` (phase=start) | Extract toolCallId, toolName, args |
| `event: tool.execute.after` | `tool_event` (phase=result) | Extract toolCallId, result |
| `event: server.heartbeat` | — | Ignore (keepalive) |
| Auth/prompt events | — | Handle via custom UI |

**The SSE event path differs too.** MiMoCode uses a **global** SSE stream (`GET /event?directory=...`), while Junction's stream model is per-bridge `emit('stream', event)`. The bridge must subscribe to the global event stream and translate events.

### 4.3 Server Lifecycle

MiMoCode requires the `mimo serve` binary to be running. Junction currently:
- **OpenClaw**: Connects to an existing gateway via WebSocket (no process management)
- **Hermes**: Spawns the dashboard subprocess (`HermesBridge.ts:320-354`)
- **Souveraine**: Spawns the Rust server subprocess (`SouveraineBridge.ts:361-393`)

The bridge must spawn `mimo serve` as a child process (like Hermes/Souveraine do) and manage its lifecycle.

### 4.4 Authentication

MiMoCode handles provider auth internally via `OPENCODE_CONFIG_CONTENT` env var. The bridge can pass provider config through this mechanism — no Junction-side auth UI needed for the basic case. For custom providers, the bridge may need a configure() dialog.

### 4.5 Model / Agent Selection

MiMoCode has an internal provider/model registry. `listModelChoices()` would need to either:
- Query the MiMoCode API for available models (if such an endpoint exists)
- Hardcode common models (like Souveraine does at `SouveraineBridge.ts:262`)
- Read model config from the MiMoCode config

### 4.6 Session History Format

`getSessionHistory()` returns data that `HistoryManager.rebuildTurnsFromGatewayHistory()` processes. MiMoCode returns messages in a different format:

```typescript
// MiMoCode response
{
  data: [
    {
      id: "msg_xxx",
      role: "user",  // or "assistant"
      content: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "thinking..." },
        { type: "file", url: "...", mime: "..." },
        { type: "tool", callID: "call_1", tool: "read_file", status: "completed", ... }
      ],
      // ...
    }
  ]
}
```

The bridge needs a **translation layer** (like `mapHermesWsEvent()` / `mapSouveraineSseEvent()`) to convert MiMoCode's message parts into Junction's transcript format.

---

## 5. What Would NOT Need to Change

### 5.1 The Webview (chat-stream.js + messages.js)

**File:** `resources/webview/chat-stream.js`

The webview is bridge-agnostic. It receives messages via `window.addEventListener('message')` and renders them. The entire webview is **unaware** of which bridge is active. No changes needed.

### 5.2 EventRouter

**File:** `src/ui/event-router.ts`

The router dispatches webview messages to ChatBase handlers by type. No bridge-specific logic exists here. No changes needed.

### 5.3 ChatPanel

**File:** `src/ui/chatPanel.ts`

This is a thin wrapper around ChatBase that creates a VSCode WebviewPanel. It's bridge-agnostic. No changes needed.

### 5.4 HistoryManager

**File:** `src/ui/history-manager.ts`

The `rebuildTurnsFromGatewayHistory()` method processes messages from `getSessionHistory()`. It's generic — it handles user/assistant/toolResult roles. As long as the bridge normalizes its messages into the expected format `{ role, content, message?: { content: [...parts] } }`, no changes needed here.

### 5.5 ConfigManager

**File:** `src/ui/config-manager.ts`

Configuration (send behavior, follow-up mode, reasoning display, animation settings) is bridge-agnostic. No changes needed.

### 5.6 ToolEventHandler

**File:** `src/ui/toolEventHandler.ts`

Handles tool event rendering from stream events. Bridge-agnostic. No changes needed.

### 5.7 ChatBase (mostly)

**File:** `src/ui/chatBase.ts`

The core `ChatBase` class orchestrates session management, message sending, and stream handling through the `bridge` property. It's designed to work with any ChatBridge. The only change needed would be adding a `mimo` key to `followUpMode` config support if desired — not required.

### 5.8 The Bridge Registry

**File:** `src/bridges/registry.ts`

Already generic — iterates all bridges, uses `bridge.id` and `bridge.label` for the environment picker. No changes needed as long as the new bridge follows the ChatBridge interface.

---

## 6. Concrete File-by-File Plan

### 6.1 Files to CREATE

#### A. `src/bridges/mimocode/MiMoCodeBridge.ts`

The main bridge implementation. Follow the `ChatBridge` interface exactly. Pattern after `SouveraineBridge.ts` (SSE-based streaming + subprocess management).

Key methods:
- `connect()` — check if `mimo serve` is running; if not, spawn it (like `SouveraineBridge.ensureManagedRuntime()` at `SouveraineBridge.ts:324`)
- `createChat()` — `POST /session` with workspace directory (like `SouveraineBridge.ts:129`)
- `sendChatMessage()` — `POST /session/{id}/message` with SSE streaming; translate SSE events via map function (like `SouveraineBridge.ts:215-235`)
- `stopRun()` — `POST /session/{id}/abort` (like `SouveraineBridge.ts:243`)
- `getSessionHistory()` — `GET /session/{id}/message` (like `SouveraineBridge.ts:173`)
- `listSessions()` — `GET /session` or use local map + workspaceState (hybrid like Hermes)
- `listModelChoices()` — query MiMoCode config or hardcode (like `SouveraineBridge.ts:262`)
- `injectMessage()` — not natively supported; implement via sendChatMessage with `/steer` prefix (like Hermes)
- `listEnvironmentChoices()` — return MiMoCode runtime + configure option (like `SouveraineBridge.ts:295`)
- `getSlashSuggestions()` — return available slash commands (like `SouveraineBridge.ts:312`)

Headline structure (from Souveraine pattern):

```typescript
export class MiMoCodeBridge extends EventEmitter implements ChatBridge {
    readonly id = 'mimocode';
    readonly label = 'MiMoCode';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,   // server-side sessions
        models: true,     // internal model registry
        agents: true,     // subagent support
        steering: false,  // no /steer equivalent
        usage: true,      // token tracking built in
        tools: true,      // internal tool execution
    };

    private server: { url: string; close(): void } | null = null;
    private client: OpencodeClient | null = null;
    private activeSessionId: string | null = null;
    private knownSessions = new Map<string, { title: string; model?: string }>();
    private selection: BridgeSelectionState = {};
    private activeAbortController: AbortController | null = null;
    // ... implement all ChatBridge methods
}
```

#### B. `src/bridges/mimocode/events.ts`

Event mapping module (like `souveraine/events.ts`, `hermes/events.ts`). Translate MiMoCode SSE events to Junction's stream event format:

```typescript
export function mapMiMoCodeEvent(event: any): MiMoCodeEventMapping {
    // Parse SSE event types -> Junction stream events
    // message.updated (role=assistant) -> agent_message + thinking_chunk
    // message.updated (with tools) -> tool_event (phase=start/result)
    // message.removed -> cleanup
}
```

This is essential because MiMoCode returns an `AssistantMessage` with `parts[]` rather than individual stream events. The mapper needs to:
1. Subscribe to the SSE `/event` stream
2. Watch for `message.updated` events with `AssistantMessage`
3. Extract parts: text → `agent_message`, reasoning → `thinking_chunk`, tool states → `tool_event`
4. Handle `finish` field in `AssistantMessage` for completion

#### C. `src/config/mimoConfig.ts` (if separate config needed)

Optional config file for MiMoCode-specific settings (like `agentBridgeConfig.ts` has `openclawConfig()`, `hermesConfig()`, `souveraineConfig()`). Could include:
- `junction.mimocode.port` or `junction.mimocode.autoPort` (default port 0 / random)
- `junction.mimocode.home` (data directory)
- `junction.mimocode.binaryPath` (path to `mimo` binary, or auto-detect on PATH)

### 6.2 Files to EDIT

#### D. `src/ui/chatViewProvider.ts` — Register the new bridge

**Line 15**: Add import and register:

```typescript
import { MiMoCodeBridge } from '../bridges/mimocode/MiMoCodeBridge`;

// In constructor, after Souveraine:
registry.register(new MiMoCodeBridge(context));
```

#### E. `src/bridges/registry.ts` — No changes needed

The registry iterates all registered bridges generically. No MiMoCode-specific logic needed.

#### F. `src/config/agentBridgeConfig.ts` — Add config accessors

Add config accessor functions if MiMoCode needs VSCode settings:

```typescript
export function mimoConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.mimocode');
}
export function getMimoBinaryPath(): string {
    return mimoConfig().get<string>('binaryPath', 'mimo');
}
```

#### G. `package.json` — Add config properties and enum values

1. Add `"mimocode"` to the `junction.activeBridge` enum:

```json
"junction.activeBridge": {
    "type": "string",
    "enum": ["openclaw", "hermes", "souveraine", "mimocode"],
    "default": "openclaw"
}
```

2. Add MiMoCode-specific config sections (optional but recommended):

```json
"junction.mimocode.port": {
    "type": "number",
    "default": 0,
    "description": "Port for MiMoCode server. 0 = auto-assign random port."
},
"junction.mimocode.home": {
    "type": "string",
    "default": "~/.mimocode-junction",
    "description": "MiMoCode data directory."
}
```

3. Add MiMoCode follow-up mode if desired:

```json
"junction.mimocode.followUpMode": {
    "type": "string",
    "enum": ["default", "queue", "steer", "interrupt"],
    "default": "default"
}
```

4. Add `"mimocode"` to `BridgeId` type in `src/bridges/types.ts` (line 1):

```typescript
export type BridgeId = 'openclaw' | 'hermes' | 'souveraine' | 'mimocode' | (string & {});
```

### 6.3 Optional Files (nice-to-have)

#### H. `resources/webview/mimocode.css` — MiMoCode-specific styling

Not needed unless MiMoCode produces unique UI elements (special status indicators, etc.).

#### I. Tests

`tests/bridge-protocol.test.js` — add MiMoCode test cases mirroring existing bridge tests.

---

## 7. Stream Event Mapping Reference

The bridge `sendChatMessage()` must emit `'stream'` events on the bridge's EventEmitter. Here's the exact mapping from MiMoCode's SSE response model:

### MiMoCode `message.updated` (role=assistant) → Junction stream events

```typescript
// MiMoCode SSE event data:
{
  type: "message.updated",
  properties: {
    info: {
      id: "msg_xxx",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking...", time: { start: 123, end: 456 } },
        { type: "text", text: "Final answer" },
        { type: "tool", callID: "call_1", tool: "read_file",
          status: "completed", input: { path: "/tmp/x" }, output: "content" },
      ],
      tokens: { input: 100, output: 50, reasoning: 30 },
      finish: "stop",
      // ...
    }
  }
}

// Translates to Junction stream events:
{ type: 'thinking_chunk', runId: sessionId, text: 'thinking...' }
{ type: 'agent_message', runId: sessionId, text: 'Final answer', delta: 'Final answer' }
{ type: 'tool_event', phase: 'start', runId: sessionId, toolCallId: 'call_1', toolName: 'read_file', args: { path: '/tmp/x' } }
{ type: 'tool_event', phase: 'result', runId: sessionId, toolCallId: 'call_1', result: 'content' }
// When finish is "stop" or "end":
{ type: 'agent_lifecycle', phase: 'completed', runId: sessionId }
// Tokens:
{ type: 'agent_lifecycle', ... } // Junction doesn't have a dedicated token event at lifecycle level
```

### Key differences from existing bridges

| Aspect | Hermes / Souveraine | MiMoCode |
|---|---|---|
| Stream granularity | Per-token deltas (`message.delta`) | Per-part updates (`message.updated` with full parts) |
| Reasoning | `thinking.delta` / `reasoning` SSE events | `reasoning` part inside `message.updated` |
| Tool calls | `tool.start`, `tool.progress`, `tool.complete` | `tool` part with `status` field (pending/running/completed/error) |
| Completion | `message.complete` event | `finish` field on AssistantMessage |
| Tokens | Separate token event | `tokens` field on AssistantMessage |
| Session | Per-message IDs | UUID-based with sessionID + messageID hierarchy |

**Implication:** The MiMoCode bridge needs to buffer part transitions and emit events in the right order to match Junction's expected streaming display. Unlike Hermes, which streams per-token, MiMoCode sends complete `message.updated` events — but the session already started, so parts arrive as batch updates with time ranges.

---

## 8. Key Implementation Notes

### 8.1 SSE Client Library

Junction already has a `streamSse()` utility in `src/bridges/http.ts` (line 68-119). It parses standard SSE (lines starting with `event:` and `data:`). MiMoCode's `/event` endpoint appears to send standard SSE. **Reuse `streamSse()`** — no new library needed.

### 8.2 Abort/Stop Connection

`sendChatMessage()` must store an `AbortController` and pass its signal to `streamSse()`. `stopRun()` aborts the controller. This is the same pattern as `SouveraineBridge.ts:222-234`.

### 8.3 `x-mimocode-directory` Header

The MiMoCode SDK uses this header to scope requests to a workspace directory. The bridge must set this to `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` on every HTTP request. This is handled transparently by `createOpencodeClient({ directory })` but must be manually set when using raw `fetch()`.

### 8.4 Server Start Timeout

MiMoCode server startup can take significant time if DB migration is needed. Use a generous timeout (30-60s, like Souveraine's 45 seconds at `SouveraineBridge.ts:343`).

### 8.5 Health Check

MiMoCode has `/global/health` or equivalent. Use this for connection readiness checks, after parsing stdout for the server URL.

### 8.6 SDK vs Raw HTTP

The bridge can either:
- **Option A (recommended):** Use `createOpencodeClient()` from `@mimo-ai/sdk` for clean typed API calls. Install the npm package as a dependency.
- **Option B:** Use raw `fetch()` with the REST API. More code but no npm dependency.

Option A is cleaner. If the SDK is not available, Option B is fine.

---

## 9. Dependency & Setup

### Required Dependencies

- `@mimo-ai/sdk` — Published npm package with the HTTP client (or raw `fetch`)
- The `mimo` CLI binary — must be on `PATH` or configurable path

### Optional Config (package.json `configuration` section)

```json
"junction.mimocode.binaryPath": {
    "type": "string",
    "default": "mimo",
    "description": "Path to the 'mimo' binary (leave as 'mimo' if it's on PATH)."
},
"junction.mimocode.port": {
    "type": "number",
    "default": 0,
    "description": "Port for the managed mimo serve. 0 = auto-assign."
},
"junction.mimocode.home": {
    "type": "string",
    "default": "~/.mimocode-junction",
    "description": "Data directory for Junction-managed MiMoCode state."
}
```
