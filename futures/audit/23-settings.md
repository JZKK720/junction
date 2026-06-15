# VS Code Settings Reference

## Global (`junction.*`)

| Key | Type | Default | Description |
|---|---|---|---|
| `junction.activeBridge` | enum | `openclaw` | Active bridge: openclaw/hermes/souveraine/mimocode/goose |
| `junction.sendBehavior` | enum | `ctrlEnter` | Composer submit key: enter/ctrlEnter/smartEnter |
| `junction.followUpMode` | enum | `default` | Global follow-up: default/queue/steer/interrupt |
| `junction.reasoningDisplay` | enum | `compact` | Thinking block display: compact/chronological |
| `junction.checkpoints.enabled` | bool | `true` | Shadow-git workspace checkpoints |
| `junction.sandboxMode` | enum | `default` | Agent sandbox display preference: default/readonly/workspace-write/full-access |
| `junction.approvalMode` | enum | `default` | Agent approval display preference: default/ask/never |
| `junction.extraRichText` | bool | `true` | Pretext canvas animated text effects |
| `junction.todoCodeLensEnabled` | bool | `false` | TODO/FIXME/HACK CodeLens provider |
| `junction.activityStream.layout` | enum | `accordion` | Tool rows layout: accordion/timeline/hybrid |
| `junction.activityStream.rail` | bool | `true` | Vertical guide rail beside activity rows |
| `junction.activityStream.condensed` | bool | `true` | Group consecutive file edits per file |
| `junction.activityStream.dots` | enum | `status` | Status dot style: status/minimal |
| `junction.bubble.radius` | number | `16` | User bubble corner radius (0–999) |
| `junction.bubble.tip` | enum | `none` | Bubble tail position: none/top-right/bottom-right |
| `junction.steerKeybinding` | string | `""` | Custom steer keybinding (e.g. `Ctrl+Shift+Enter`) |
| `junction.showFullHistory` | bool | `false` | Load 1000 messages instead of 200 |
| `junction.autoSendFileContext` | bool | `true` | Auto-stage editor context on file switch |
| `junction.fileContextInterval` | number | `5000` | File context poll interval in ms |

## OpenClaw (`junction.openclaw.*`)

| Key | Default | Description |
|---|---|---|
| `gatewayUrl` | `ws://127.0.0.1:18789` | WS gateway URL |
| `configPath` | `""` | Path to openclaw.json |
| `followUpMode` | `default` | Per-bridge follow-up override |

## Hermes (`junction.hermes.*`)

| Key | Default | Description |
|---|---|---|
| `dashboardUrl` | `http://127.0.0.1:9119` | Dashboard HTTP URL |
| `wsUrl` | `ws://127.0.0.1:9119/api/ws` | WS JSON-RPC endpoint |
| `apiBaseUrl` | `http://127.0.0.1:8642` | REST API URL |
| `home` | `~/.hermes-hermling` | Home for managed spawn |
| `repoPath` | `""` | Repo path for managed spawn (empty = disabled) |
| `followUpMode` | `default` | Per-bridge follow-up override |

## Souveraine (`junction.souveraine.*`)

| Key | Default | Description |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8484` | HTTP server URL |
| `home` | `~/.souveraine-souvieling-home` | Home for managed spawn |
| `repoPath` | `""` | Repo path for managed spawn (empty = disabled) |
| `followUpMode` | `default` | Per-bridge follow-up override |

## MiMoCode (`junction.mimocode.*`)

| Key | Default | Description |
|---|---|---|
| `serverUrl` | `""` | External server URL (empty = managed spawn) |
| `binaryPath` | `"mimo"` | Path to mimo binary |
| `port` | `0` | Managed server port (0 = random) |
| `home` | `~/.mimocode-junction` | Data directory for managed state |
| `followUpMode` | `default` | Per-bridge follow-up override |

## Goose (`junction.goose.*`)

| Key | Default | Description |
|---|---|---|
| `serverUrl` | `""` | ACP server URL (empty = auto-detect localhost:3284) |
| `home` | `""` | Goose data dir (empty = auto-detect) |
| `binaryPath` | `""` | Path to goose binary (empty = auto-detect from PATH) |
