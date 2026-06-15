# TODO CodeLens Integration

Registered for all `file://` scheme documents. Disabled by default.

## Behavior

- Scans each line for `TODO`, `FIXME`, or `HACK` (case-insensitive)
- Shows "Implement with Junction" CodeLens above each match
- Clicking:
  1. Attaches file pill for the source file
  2. Sends `Implement this code comment:\n<relative-path>:<line>\n<match-text>` as a message
  3. Focuses the Junction sidebar

## Setting

`junction.todoCodeLensEnabled` (bool, default `false`)
