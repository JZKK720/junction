# Follow-Up Queue System

When a run is active, incoming messages are handled per `followUpMode`.

## Modes

| Mode | Behavior |
|---|---|
| `queue` | Hold message until current run completes; send as next dispatch |
| `steer` | Inject into running turn via bridge steer API; fallback to queue on failure |
| `interrupt` | Stop current run (`bridge.stopRun()`), then send as new message |

Mode resolved: per-bridge setting → global `junction.followUpMode` → `queue` default.

## Queue Operations

| Operation | Detail |
|---|---|
| Enqueue | Message added with unique ID; `queueState` posted to webview |
| Edit | In-place text replacement; transcript turn updated; `queuedUserUpdated` event |
| Reorder | Move up/down by swapping arrays; first item never `groupWithPrevious` |
| Group | Toggle `groupWithPrevious` flag on adjacent items; grouped items dequeued together as `\n\n`-joined string |
| Remove | Splice from all arrays; transcript turn removed; `queuedUserRemoved` event |
| Dequeue | On run completion: `dequeueFollowUp()` pops first item (+ any grouped followers) and dispatches immediately |
| Clear | All arrays emptied; `queueState` pushed |

## Steer Fallback

If `bridge.injectMessage()` fails: posts `steerFailed` event to webview, then enqueues message as normal queue item.

## Dispatch Override

`handleUserMessage(text, dispatchOverride)` accepts `'queue' | 'steer' | 'interrupt'` to override the configured mode for a single message.
