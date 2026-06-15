# Tool Activity Stream

## Layout (`junction.activityStream.layout`)

| Option | Behavior |
|---|---|
| `accordion` | Finished activity folds into a summary ("Edited 2 files, ran 3 commands") |
| `timeline` | Rows stay inline on a vertical timeline rail; nothing folds |
| `hybrid` | Activity folds into accordion AND expanded body renders as a timeline rail |

## Settings

| Setting | Default | Effect |
|---|---|---|
| `junction.activityStream.rail` | `true` | Show vertical guide line beside activity rows (timeline/hybrid only) |
| `junction.activityStream.condensed` | `true` | Group consecutive file edits into one accordion section per file instead of one row per edit |
| `junction.activityStream.dots` | `status` | `status` = colored dots (green success, red error, blinking while running) · `minimal` = neutral dots + spinner while running |

## Stream Events

| Event | Detail |
|---|---|
| `tool_start` | Tool call begins; `toolName`, `args` |
| `tool_update` | Incremental output text |
| `tool_result` | Final result; `isError` flag |
| `subagentInfo` | Subagent spawn detected (`:subagent:` in session key or `spawnedBy` field) |
| `tokenUsage` | `inputTokens`, `outputTokens` after run completion |
