# Extension Identity, Commands, Status Bar

## Identity

| | |
|---|---|
| Name | `junction` (displayName: **Junction**) |
| Publisher | `Plaer1` |
| Version | `0.0.1` |
| Activation | `onStartupFinished` |
| Surface | Secondary sidebar (`junction-explorer` container) |
| Compat aliases | `openclaw.*` commands registered as hidden aliases |

## Icons

- `resources/icon.png` — marketplace / extensions-panel icon (128×128 PNG)
- `resources/icon.svg` — activity-bar tab icon (24×24 SVG, `stroke="currentColor"`, `fill="none"`)

### Known issue / task

**Activity-bar tab still shows old lobster icon after icon files updated.**  
Root cause: `resources/icon.png` and `resources/icon.svg` were replaced (wheel design) in working tree but the old lobster commit remained in HEAD.  Fix: commit wheel icons (done in cleanup commit). If icon still shows lobster after build deploy, VS Code requires a full restart (not just window reload) to flush its icon cache from `plaer1.junction-0.0.1`.  
Also verify: `build.js` deploys both icon files to all `plaer1.junction*` extension dirs so installed copies stay in sync.

## Commands

| Command ID | Title | Surface |
|---|---|---|
| `junction.configureRuntime` | Configure Runtime | Status bar click |
| `junction.openChat` | Open Sidebar | Command palette |
| `junction.showLogs` | Show Logs | Command palette |
| `junction.addToThread` | Add to Junction Thread | Editor context menu |
| `junction.addFileToThread` | Add File to Junction Thread | Editor title + explorer context menus |
| `junction.todoCodeLens.send` | _(internal)_ | Registered by CodeLens provider |

## Status Bar

- Shows on startup: `$(sync~spin) Junction`
- Connected: `$(check) <bridge-label>`
- Disconnected: `$(debug-disconnect) <bridge-label>` with warning background
- Pairing required: `$(key) <bridge-label>: approval needed`
- Bridge switch: momentary spin while reconnecting
- Clicking opens configure-runtime dialog
