# Junction

A VS Code chat sidebar that bridges your editor to local AI coding agents —
**OpenClaw**, **Hermes**, and **Souveraine** — through one unified UI.

## Features

- **Chat sidebar** — talk to the active agent bridge from VS Code's secondary sidebar
- **Multi-bridge** — switch between OpenClaw, Hermes, and Souveraine runtimes
- **Workspace context** — stages the active file/selection as context for the agent
- **Model + reasoning picker** — pick a model and its reasoning effort per session
- **Markdown rendering** — assistant responses, tool cards, and diffs render inline
- **Auto-reconnection** — reconnects to the runtime if the connection drops

## Requirements

- A local agent runtime running (e.g. the OpenClaw Gateway on `ws://127.0.0.1:18789`)
- VS Code 1.95.0 or higher

## Installation

### Build + install locally
```bash
npm install
./compile-and-install.sh   # builds and installs into ~/.vscode/extensions
```
Then run **Developer: Reload Window** in VS Code.

### Debug
Press `F5` in VS Code to launch the Extension Development Host.

## Usage

### Open the chat
- Command Palette: `Junction: Open Sidebar` (`junction.openChat`)

### File context
- **Drag-and-drop** files from VS Code into the chat input to insert full paths
  (multiple files land on separate lines).
- Right-click a file/selection → **Add to Junction Thread** / **Add File to Junction Thread**.

## Architecture

```
┌─────────────────────────────────────────┐
│            Junction (VS Code)            │
│  ┌────────────┐      ┌──────────────┐    │
│  │ Chat UI    │      │ Context      │    │
│  │ (Webview)  │      │ Tracker      │    │
│  └─────┬──────┘      └──────┬───────┘    │
│        └────────┬───────────┘            │
│                 │  BridgeRegistry        │
└─────────────────┼────────────────────────┘
                  │
     ┌────────────┼────────────┐
     │            │            │
┌────▼────┐  ┌────▼────┐  ┌────▼─────┐
│ OpenClaw│  │ Hermes  │  │Souveraine│   ← agent backends
└─────────┘  └─────────┘  └──────────┘
```

## Project structure

```
src/
├── extension.ts            # entry point, command + status bar wiring
├── bridges/                # OpenClaw / Hermes / Souveraine bridge adapters
├── gateway/                # OpenClaw WebSocket client, sessions, models
├── ui/                     # ChatBase + sidebar/panel webview providers
├── context/                # workspace + selection tracking, TODO CodeLens
├── checkpoints/            # shadow-git workspace checkpoints
└── config/                 # settings accessors (junction.* keys)
resources/webview/          # modular webview UI (template + per-component JS/CSS)
```

## Development

```bash
npm run build     # bundle to dist/extension.js
npm run watch     # rebuild on change
npm test          # typecheck + bridge-protocol tests
```

## Credits

Junction began as a fork of [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode)
by Owen-Liuyuxuan (MIT). The WebSocket/gateway plumbing traces back to that project; the
multi-bridge architecture (OpenClaw / Hermes / Souveraine), the modular webview UI, checkpoints,
and the model/session managers are original to Junction.

## License

MIT. © Owen-Liuyuxuan (original openclaw_vscode), © Plaer1 (Junction). See [LICENSE](LICENSE).
