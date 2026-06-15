# History & Transcript

## Loading

- Loaded on connect/session switch
- Default limit: 200 messages; 1000 with `junction.showFullHistory`
- JSONL offset-based reader for OpenClaw (`getSessionHistoryFromJsonl`, 256 KB chunks per page)
- "Load more" triggered by button or scroll-to-top

## Transcript Rebuild

- `rebuildTurnsFromGatewayHistory(messages)` normalizes raw gateway format into `TranscriptTurn[]`
- Handles: text parts, reasoning/thinking parts, tool_use/tool-call/toolCall parts
- Supports: Hermes `{ role, text }`, Souveraine content arrays, MiMoCode `{ info: { role }, parts }`
- Role normalization: `message_type` fields (`user_message`, `assistant_message`, `reasoning_message`)

## Deduplication

- Duplicate assistant messages detected by normalized text comparison
- Recent turns scanned backward; duplicates from a different runId dropped
- Prevents double-rendering when both SSE delta and blocking POST return same content

## History Filtering

- Messages with workspace context prefix hidden from display (`VSCODE_WORKSPACE_CONTEXT_PREFIX`, `[Workspace File Context]`, `[Attached Context]`)
- User messages have workspace path prefix stripped for display

## Caching

- In-memory `sessionTranscripts` Map: keyed by session key
- Restored without network call on session switch
- Invalidated on bridge switch

## Transcript Turn Shape

Each `TranscriptTurn` has:
- `id`, `role`, `content`, `messageId`, `runId?`, `hasCheckpoint?`, `isSteer?`, `reaction?`
- `thinking?`, `thinkingComplete?`, `thinkingDurationMs?`
- `tools?: TranscriptTool[]`
