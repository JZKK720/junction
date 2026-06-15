# Checkpoints — Code Rewind

Shadow git repo in extension global storage. Never touches the real `.git`.

## Mechanism

- `CheckpointManager` initialized with `ExtensionContext`
- Shadow repo path: `globalStorageUri/checkpoints/<sha256(workspaceRoot)[0:16]>/git`
- Work tree: workspace root
- Git identity: `Junction Checkpoints <checkpoints@junction.local>`
- Excludes: `node_modules/`, `.git/`, `.openclaw/`, `.agent-bridge/`

## Snapshot

- Triggered at every user turn (before `bridge.sendChatMessage()`)
- `git add -A` + `git commit --allow-empty --no-verify -m <label>`
- SHA stored in `map[messageId]`; persisted in `workspaceState` as `junction.checkpoints`
- Returns SHA or null on failure

## Rewind

1. Snapshot current state first (rewind is undoable)
2. `git checkout <sha> -- .` (restore tracked files)
3. Compute `git diff --name-only --diff-filter=A <sha>` (files added since snapshot)
4. For each added file that is in `touchedPaths`: `fs.rmSync()` (scoped — never touches unrelated untracked files)

## Touched Path Tracking

- `recordTouchedPath(filePath)` called from tool event args/results
- `recordTouchedPathsFromValue(value)` recurses any object looking for `path`, `file`, `filePath`, `filename`, `target`, `targetPath` keys
- Ensures rewind only removes files the agent actually added

## UI

- `hasCheckpoint` flag on `TranscriptTurn` → "Rewind code to here" button shown on user message
- `checkpointReady` event posted to webview when snapshot succeeds
- Enable/disable: `junction.checkpoints.enabled` (default `true`)
