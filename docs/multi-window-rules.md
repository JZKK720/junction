# Multi-Window Awareness Rules

Junction runs one `ChatViewProvider` per VS Code window, but all windows share
the same `BridgeRegistry` and bridge instances. Stream events from the gateway
are received by ALL windows simultaneously.

## The Problem

Without filtering, Window A's agent run produces events that appear in Window B's
chat. This manifests as:
- Messages from one chat appearing in another
- Tool blocks from one session showing in a different session
- Thinking indicators firing in the wrong window
- "Working…" shimmer appearing in multiple windows

## The Rules

### 1. Every event handler MUST check `viewSessionKey`

```typescript
// At the top of handleStreamEvent and any future event handler:
const eventSession = String(event?.sessionKey ?? '').trim();
if (this.viewSessionKey) {
    if (eventSession && eventSession !== this.viewSessionKey) return;
    if (!eventSession && event.runId && !this.activeRuns.has(event.runId)
        && event.type !== 'agent_lifecycle') return;
}
```

### 2. NEVER modify DOM directly from event handlers

Always post to the webview via `postToWebview()`. The webview is per-window,
so only this window's DOM is affected. Direct DOM manipulation from the
extension side affects shared state.

### 3. `activeRunId` is per-instance, but verify at call sites

Each `ChatBase` instance has its own `activeRunId`. But if a bridge event
arrives without a sessionKey, it could match the wrong instance. Always
verify via `viewSessionKey` before processing.

### 4. Bridge event listeners must be scoped to the active bridge

```typescript
// CORRECT: listen to active bridge only
this.attachBridgeStreamListener(this.bridgeRegistry.active);

// WRONG: listen to all bridges
for (const bridge of this.bridgeRegistry.getAll()) {
    bridge.on('stream', handler); // ← bleeds across windows
}
```

### 5. Session lifecycle must set `viewSessionKey`

Every code path that creates or switches to a session MUST set
`this.viewSessionKey`:
- `handleResumeSession(key)` → `this.viewSessionKey = key`
- `handleNewChat()` → `this.viewSessionKey = null`
- `dispatchUserMessage` (new chat creation) → `this.viewSessionKey = key`
- `handleInitRequest()` → `this.viewSessionKey = getCurrentSessionKey()`

### 6. Bridge switch must clear ALL per-view state

When `bridgeRegistry.on('changed')` fires:
1. Detach old bridge listener
2. Attach new bridge listener
3. Clear: `activeRuns`, `activeRunId`, `thinkingBuffers`, `thinkingStart`,
   `currentThinking`, `pendingFollowUp`
4. Send `clearChat` to webview
5. Send `runActive: false` to webview

### 7. `setWorking` is per-view (DOM) — safe by default

`setWorking` modifies `workingRow` which is a DOM element owned by this
view's webview. Since `postToWebview` sends to this view only, `setWorking`
doesn't bleed. But if you add shared state to the working indicator, it
WILL bleed.

### 8. Testing: open two windows, run different sessions

Before merging any event-handling change:
1. Open two VS Code windows with the same workspace
2. Start a chat in Window A (session A)
3. Start a chat in Window B (session B)
4. Send messages in both — verify no cross-contamination
5. Switch bridges in one window — verify the other is unaffected

## What Bleeds Today (Known)

- `workingRow` DOM reference — safe (per-view webview)
- `activeRunId` — scoped per-instance but unguarded for events without sessionKey
- `thinkingBuffers` — scoped per-instance but unguarded for events without sessionKey
