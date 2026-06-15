# Thinking / Reasoning

## Streaming

- `thinking_chunk` events accumulated in `thinkingBuffers` Map (keyed by runId)
- Start time recorded on first chunk; duration computed on `thinking_end`
- Buffer flushed and `thinking_end` posted on run finalization

## Display Modes (`junction.reasoningDisplay`)

| Mode | Behavior |
|---|---|
| `compact` | Expands while streaming; auto-collapses to summary when run completes |
| `chronological` | Shows `Thinking… ~N tokens` pill during run; reveals full text and stays expanded after |

## OpenClaw Special Case

- Raw thinking text hidden: `hidesRawThinking()` returns true for OpenClaw
- Extension sends empty `text`/`fullText` in `thinking_chunk` events to webview
- Webview shows collapsed summary only (token count from buffer length)
- Other bridges: full thinking text streamed and shown

## Reasoning Effort Picker

- Per-model submenu in model picker
- Canonical OpenClaw levels (always-available fallback): `off · minimal · low · medium · high`
- Hermes: uses model's own advertised effort vocab when available; falls back to canonical levels if model supports reasoning but advertises none
- Souveraine/MiMoCode: canonical levels only (no per-model caps endpoint)
- Selected effort stored in `currentThinking`; passed in `BridgeSelectionState`

## History Restore

- Thinking blocks restored with `thinking`, `thinkingComplete`, `thinkingDurationMs` fields on `TranscriptTurn`
- OpenClaw: thinking text stripped from history messages before render (only duration/token count shown)
