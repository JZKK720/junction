# Subagent Detection

The extension detects and surfaces subagent spawns in the stream.

## Detection

Stream events checked for:
- Session key containing `:subagent:` substring
- `spawnedBy` field present
- `subagentRole` field present
- `spawnDepth` field present

## UI Event

When detected, posts `subagentInfo` to webview:

```json
{
  "type": "subagentInfo",
  "runId": "...",
  "sessionKey": "...",
  "spawnedBy": "...",
  "subagentRole": "...",
  "spawnDepth": 1
}
```

Webview renders a subagent badge/indicator in the tool stream.
