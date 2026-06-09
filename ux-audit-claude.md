# Claude Code VSCode Extension — UX Audit

**Version audited:** 2.1.158 (Anthropic)
**Date:** 2026-05-31
**Installed path:** `/home/e/.vscode/extensions/anthropic.claude-code-2.1.158-linux-x64/`

---

## Summary Comparison Table

| UX Pattern | Claude Code (v2.1.158) | OpenClaw VSCode (v0.2.0) | Gap |
|---|---|---|---|
| **Chat surface** | WebView panel (tab or sidebar) | VS Code ChatParticipant + webview sidebar | Different paradigm — Claude rolled custom, we use VS Code native |
| **Model picker** | VS Code QuickPick via postMessage | Settings-based (config file) | Claude has inline picker |
| **Permission mode** | QuickPick picker (default/acceptEdits/plan/bypass) | Mapped via gateway configs | Claude has first-class modes |
| **Activation** | `onStartupFinished` + `onWebviewPanel` | `onStartupFinished` only | Claude eager-loads on view open |
| **Keybindings** | 8 default bindings (focus, blur, @-mention, new conv, reopen session) | None | Claude ships with keyboard-driven UX |
| **File context** | Alt+K `@-mention` from editor, selection-based | `autoSendFileContext` interval pushing | Different approach — manual vs auto |
| **Inline editor** | No (panel-only, opens diff editor for changes) | No (chat participant only) | Neither does inline decorations |
| **Diff handling** | Accept/Reject toolbar buttons on VS Code diff editor | N/A | Claude has full diff workflow |
| **Sessions** | Dedicated sidebar webview, `/resume` command, Cmd+Shift+T reopen | Tree view in sidebar | Claude sessions are richer |
| **Status bar** | "✻ Claude Code" (sidebar mode only) | None | Claude has minimal presence |
| **Onboarding** | 4-step walkthrough + checklist | None | Claude ships guided experience |
| **Theme** | Custom CSS variables → VS Code tokens, codicon font, `.vscode-light` override | Unknown (not audited here) | Claude fully VS Code-native themed |
| **CSP** | `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-...'; img-src data:` | Unknown | Claude has locked-down CSP |
| **retainContextWhenHidden** | `true` on all webviews | Unknown | Claude preserves webview state |
| **Location** | Sidebar **or** Panel (tab), user-switchable | SecondarySidebar only | Claude dual-location |
| **Categories** | "AI", "Chat" | "Other" | Marketplace discoverability gap |

---

## 1. Commands — Full UX Surface (22 commands)

Claude registers 22 commands, all surfaced via Command Palette:

| Command | UX Role |
|---|---|
| `claude-vscode.editor.open` | Open in New Tab (Cmd+Shift+Escape) |
| `claude-vscode.editor.openLast` | Open (smart-reopen last location) |
| `claude-vscode.primaryEditor.open` | Open in Primary Editor |
| `claude-vscode.sidebar.open` | Open in Side Bar |
| `claude-vscode.window.open` | Open in New Window |
| `claude-vscode.terminal.open` | Open in Terminal |
| `claude-vscode.newConversation` | New Conversation (opt-in Cmd+N) |
| `claude-vscode.reopenClosedSession` | Reopen Closed Session (Cmd+Shift+T) |
| `claude-vscode.focus` | Focus Claude input (Cmd+Escape when editing) |
| `claude-vscode.blur` | Blur Claude → focus editor (Cmd+Escape when in Claude) |
| `claude-vscode.insertAtMention` / `claude-code.insertAtMentioned` | `@`-mention current file/selection (Alt+K / Cmd+Alt+K) |
| `claude-vscode.acceptProposedDiff` / `claude-code.acceptProposedDiff` | Accept proposed file changes |
| `claude-vscode.rejectProposedDiff` / `claude-code.rejectProposedDiff` | Reject proposed file changes |
| `claude-vscode.installPlugin` | Plugin marketplace |
| `claude-vscode.update` | Update extension |
| `claude-vscode.logout` | Logout |
| `claude-vscode.createWorktree` | Git worktree |
| `claude-vscode.showLogs` | Show extension logs |
| `claude-vscode.openWalkthrough` | Open onboarding walkthrough |

**Key insight:** Claude has commands hidden from the Command Palette when inappropriate (`"when": "false"`), e.g. `openLast`, `blur`, `newConversation` — these are triggered only via keyboard shortcut.

---

## 2. Views & WebView Panels

### Three View Containers (Activity Bar)

1. **`claude-sidebar`** — Primary sidebar (VS Code <1.102, no secondary sidebar support)
2. **`claude-sidebar-secondary`** — Secondary sidebar (VS Code ≥1.102)
3. **`claude-sessions-sidebar`** — Session list sidebar (togglable via context key)

### Three WebView Views

1. **`claudeVSCodeSidebar`** — Main chat webview in sidebar
2. **`claudeVSCodeSidebarSecondary`** — Main chat webview in secondary sidebar
3. **`claudeVSCodeSessionsList`** — Session list webview

All three use `retainContextWhenHidden: true` — webview state persists when switching away.

### Plus: Panel Mode (CreateWebviewPanel)

Claude also uses `vscode.window.createWebviewPanel("claudeVSCodePanel", ...)` for tab-based chat (default). The user can switch between sidebar and panel via `claudeCode.preferredLocation` config or by dragging the panel to sidebar.

### WebView HTML Assembly

- HTML is generated dynamically with CSP nonce
- Resources loaded via `asWebviewUri()` — no external fetches
- Codicon font embedded inline as base64 data URI (no network dependency)
- Custom fonts loaded through `@font-face` in CSS with webview URIs

---

## 3. Chat Flow — How Users Send Messages

### Input Mechanism

The chat input is a **webview-hosted prompt area** using React components. Key behaviors:

- **Enter sends** by default (configurable: `claudeCode.useCtrlEnterToSend` makes Ctrl/Cmd+Enter send)
- **@-mentions** for files/folders: type `@` in input to insert file references
- **Selection-based context:** Highlight text in editor, then Alt+K / Cmd+Alt+K inserts `@filepath` with selection range
- **Slash commands:** `/resume`, `/clear`, etc. available in the input (slash command autocomplete)
- **Permission requests** shown inline as tool-approval cards (not VS Code notifications)
- **Plan mode** shows plan previews before execution
- **Review upsell banner** shown to prompt users to try accept-edits mode
- **Terminal banner** shown to suggest trying terminal mode

### Agent Communication

The webview uses `acquireVsCodeApi()` and `postMessage` with 144 distinct message types. The extension host acts as a bridge between the webview UI and the native Claude binary process:

```
WebView UI ←→ postMessage ←→ Extension Host ←→ Claude Native Binary (spawned process)
```

Key message categories:
- **Agent interaction:** `launch_claude`, `interrupt_claude`, `cancel_request`, `io_message`
- **File ops:** `open_file`, `open_diff`, `open_file_diffs`, `list_files_request`, `get_current_selection`
- **Session mgmt:** `list_sessions_request`, `delete_session`, `rename_session`, `fork_conversation`, `teleport_session`
- **Config/model:** `set_model`, `set_permission_mode`, `set_thinking_level`, `apply_settings`
- **Auth:** `login`, `logout`, `submit_oauth_code`, `submit_mcp_oauth_callback_url`
- **Plugins/MCP:** `install_plugin`, `list_plugins`, `set_mcp_server_enabled`, `authenticate_mcp_server`
- **Browser:** `create_new_browser_tab`, `browser`, `browserInstruction`
- **Content rendering:** `user`, `system`, `text`, `code`, `tool_use`, `tool_result`, `diff`, `heading`, `link`, `image`, `table`

### State Initialization

On webview ready, the extension sends `init` with full state:
```javascript
{
  isFullEditor: window.IS_FULL_EDITOR,
  authStatus, modelSetting, thinkingLevel,
  permissionMode, defaultCwd, openNewInTab,
  showTerminalBanner, showReviewUpsellBanner,
  isOnboardingEnabled, isOnboardingDismissed,
  // ...
}
```

---

## 4. Theme / Styling

### Custom CSS Variable System

Claude defines an **`--app-*` variable layer** that maps to VS Code theme tokens:

```css
--app-primary-foreground: var(--vscode-foreground);
--app-primary-background: var(--vscode-sideBar-background);
--app-secondary-foreground: var(--vscode-descriptionForeground);
--app-secondary-background: var(--vscode-editor-background);
--app-input-background: var(--vscode-input-background);
--app-input-border: var(--vscode-inlineChatInput-border);
--app-input-active-border: var(--vscode-inputOption-activeBorder);
--app-button-foreground: var(--vscode-button-foreground);
--app-button-background: var(--vscode-button-background);
--app-button-hover-background: var(--vscode-button-hoverBackground);
--app-accent-color: var(--vscode-inputOption-activeBorder);
--app-link-foreground: var(--vscode-textLink-foreground);
--app-list-hover-background: var(--vscode-list-hoverBackground);
--app-list-active-background: var(--vscode-list-activeSelectionBackground);
--app-menu-background: var(--vscode-menu-background);
--app-monospace-font-family: var(--vscode-editor-font-family, monospace);
--app-monospace-font-size: var(--vscode-editor-font-size, 12px);
```

**This is the pattern to adopt** — a clean `--app-*` abstraction that makes every CSS rule reference app variables rather than raw `--vscode-*` tokens.

### Brand Colors

```css
--app-claude-orange: #d97757;
--app-claude-clay-button-orange: #c6613f;
--app-claude-ivory: #faf9f5;
--app-claude-slate: #141413;
```

These are the only hardcoded brand colors; everything else resolves through VS Code theme variables.

### Light/Dark Mode

- **Dark mode:** Default — variable values from VS Code dark theme work as-is
- **Light mode:** Single `.vscode-light` class override for 2 variables:
  ```css
  .vscode-light {
    --app-transparent-inner-border: #00000012;
    --app-spinner-foreground: var(--app-claude-clay-button-orange);
  }
  ```
- **High contrast:** Inherits VS Code HC variables (`.hc-black`, `.hc-light` classes are present in the CSS for MCB-specific adjustments)
- **No `data-theme` attribute** — relies entirely on VS Code's built-in `.vscode-dark` / `.vscode-light` / `.vscode-high-contrast` body classes
- **`color-scheme` property** used for native form elements: `color-scheme: light` on specific buttons that need light appearance

### Codicon Icon Font

Embedded as inline base64 `@font-face` in CSS (no network fetch). The webview references VS Code's codicon icon set natively.

### Spacing Tokens

```css
--app-spacing-small: 4px;
--app-spacing-medium: 8px;
--app-spacing-large: 12px;
--app-spacing-xlarge: 16px;
--corner-radius-small: 4px;
--corner-radius-medium: 6px;
--corner-radius-large: 8px;
```

### Font Stack

```css
font-family: var(--vscode-chat-font-family);
font-size: var(--vscode-chat-font-size, 13px);
```

Mono font for code blocks:
```css
font-family: var(--vscode-editor-font-family, monospace);
font-size: var(--vscode-editor-font-size, 12px);
```

### CSS Module Scoping

CSS classes are scoped with content-hash suffixes: `._uq5aLg`, `.Eg8KCQ`, `.lcdCYQ` — indicating a CSS-in-JS or CSS Modules build system (likely PostCSS modules in the React toolchain).

### What Claude Does Well (Styling)

1. ✅ **Single source of truth:** `--app-*` variables are the only CSS variables referenced in component styles — never raw `--vscode-*`
2. ✅ **Minimal light-mode override** (only 2 variables need adjusting)
3. ✅ **Full VS Code theme token alignment** — picks appropriate tokens for each semantic purpose
4. ✅ **Inline codicon font** — zero network dependency for icons
5. ✅ **Consistent spacing system** — `--app-spacing-*` tokens used throughout

---

## 5. Model Picker

The model picker is **not a webview dropdown** — it uses VS Code's native `QuickPick` API via postMessage:

```
WebView: postMessage({ type: "set_model", model: "..." })
  → Extension host: this.setModel(channelId, modelValue)
  → Sends to Claude binary process
  → Returns: { type: "set_model_response" }
```

The model list is returned as part of the initial `get_claude_state` response. The webview renders the current model name in the header area, and clicking it likely opens the QuickPick via a `postMessage` call to the extension host.

**Configuration path:** Models are managed in Claude's `.claude/settings.json` with `model` key, not through VS Code settings. The extension reads this from the Claude binary process.

**What's clever:** Using QuickPick keeps the UX native — keyboard navigation, fuzzy search, theming all work automatically. No custom dropdown to maintain.

---

## 6. File Context — @-Mention System

### Two Insertion Methods

1. **From the chat input:** Type `@` in the Claude prompt input → file/folder autocomplete appears in the webview
2. **From the editor:** Alt+K / Cmd+Alt+K → inserts `@${relativePath}` into the Claude input
   - If selection is empty: inserts `@path/to/file`
   - If text selected: inserts `@path/to/file:startLine-endLine` with selection range

### Implementation

```javascript
// From extension.js (reconstructed)
vscode.commands.registerCommand("claude-vscode.insertAtMention", async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const relativePath = vscode.workspace.asRelativePath(editor.document.fileName);
  const selection = editor.selection;
  if (selection.isEmpty) {
    eventEmitter.fire(`@${relativePath}`);
  } else {
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    eventEmitter.fire(`@${relativePath}:${startLine}-${endLine}`);
  }
});
```

The event goes to the webview which updates the input state.

### Mention Chips Rendering

In the webview, `@` references render as styled **mention chips**:
```css
.mentionChip {
  display: inline;
  background-color: var(--app-mention-chip-background);  /* maps to vscode-chat-slashCommandBackground */
  color: var(--app-mention-chip-foreground);              /* maps to vscode-chat-slashCommandForeground */
  border-radius: 3px;
  padding: 1px 4px;
}
```

Clickable mention chips: `cursor: pointer` + `filter: brightness(1.15)` on hover.

---

## 7. Activation

```json
"activationEvents": [
  "onStartupFinished",
  "onWebviewPanel:claudeVSCodePanel"
]
```

- **`onStartupFinished`** ensures the extension is loaded when VS Code finishes startup — it registers all commands and views immediately
- **`onWebviewPanel:claudeVSCodePanel`** is a fallback to handle cases where the panel ID was already restored from a previous session

The status bar item is created in the `activate()` function and shown only when `preferredLocation === "sidebar"`:
```javascript
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right
);
statusBarItem.text = "✻ Claude Code";
statusBarItem.command = "claude-vscode.editor.openLast";
statusBarItem.tooltip = "Open Claude Code";
if (getPreferredLocation() === "sidebar") statusBarItem.show();
```

---

## 8. Status Bar

- **Text:** "✻ Claude Code"
- **Alignment:** Right side
- **Command:** Opens Claude (smart-reopens last location)
- **Visibility:** Only when `preferredLocation` is "sidebar" — hidden in panel mode
- **Single item, minimal**

---

## 9. Keyboard Shortcuts

| Shortcut | Command | Context |
|---|---|---|
| `Cmd+Escape` | Focus Claude | `!config.claudeCode.useTerminal && editorTextFocus` |
| `Cmd+Escape` | Blur Claude → Focus editor | `!config.claudeCode.useTerminal && !editorTextFocus` |
| `Cmd+Shift+Escape` | Open Claude tab | `!config.claudeCode.useTerminal` |
| `Cmd+Escape` | Open terminal mode | `config.claudeCode.useTerminal` |
| `Alt+K` | Insert @-mention (standalone ext) | `editorTextFocus` |
| `Cmd+Alt+K` | Insert @-mention (terminal ext) | `editorTextFocus` |
| `Cmd+N` | New conversation | `config.claudeCode.enableNewConversationShortcut && Claude focused` |
| `Cmd+Shift+T` | Reopen closed session | `config.claudeCode.enableReopenClosedSessionShortcut && last closed was Claude` |

**Design decisions:**
- `Cmd+Escape` dual-purposed: focus Claude when in editor, blur Claude when in chat — smart context-aware toggle
- `Cmd+N` new conversation is **opt-in** (off by default) to avoid stealing VS Code's default new-file shortcut
- `Cmd+Shift+T` reopen session is **on by default** but uses context key `claude-vscode.lastClosedWasSession` so it only intercepts when the last closed tab was a Claude session — otherwise falls through to VS Code's native "reopen closed editor"

---

## 10. Inline vs Panel

Claude Code is **panel-only** — no inline editor decorations or inline chat. However:

### Diff Viewing is Semi-Inline

When Claude proposes file changes, they open in a **VS Code diff editor** with accept/reject toolbar buttons:
```json
"editor/title": [
  { "command": "claude-vscode.acceptProposedDiff", "when": "claude-vscode.viewingProposedDiff", "group": "navigation" },
  { "command": "claude-vscode.rejectProposedDiff", "when": "claude-vscode.viewingProposedDiff", "group": "navigation" }
]
```

The context key `claude-vscode.viewingProposedDiff` is set when the diff editor opens:
```javascript
vscode.commands.executeCommand("setContext", "claude-vscode.viewingProposedDiff", true);
```

This is a clean pattern: Claude doesn't try to re-implement diff viewing in the webview — it delegates to VS Code's native diff editor.

### Tool Use Rendering (In-WebView)

Tool calls (bash, file operations, browser, etc.) are rendered inline in the chat webview with:
- **Tool use blocks:** `toolUse` CSS class — full-width, card-style
- **Tool results:** `toolResult` CSS class — monospace, scrollable `<pre>` blocks with `var(--app-code-background)` background
- **Tool references:** `toolReference` CSS class — secondary-foreground color for "referenced file" displays

### Plan Mode Previews

When in plan mode, Claude renders plan previews in the webview before executing. The user can approve/close via postMessage commands (`close_plan_preview`).

---

## 11. Content Security Policy

```http
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{{NONCE}}'; img-src data:
```

### Production CSP (with dynamic additions)

```javascript
`default-src 'none'; ${D}; ${M}; ${G}; script-src 'nonce-${q}'; ${F};`
```

Where:
- `D` = media sources (likely `media-src ...` for audio recording playback)
- `M` = connect sources (WebSocket for live updates?)
- `G` = font sources (likely `font-src data:` for base64 codicon)
- `F` = style additions (likely builds on `style-src 'unsafe-inline'`)
- `q` = random nonce

**No `img-src https:`** — images come through the extension host as data URIs or webview URIs.

---

## 12. Session Management

### Session List Sidebar

A dedicated webview view (`claudeVSCodeSessionsList`) provides:
- List of past sessions
- Rename, delete, fork
- "Past Conversations" button in the header
- `/resume` slash command

### Session Lifecycle

- Sessions created via Claude CLI binary
- Listed via `list_sessions_request` → `list_sessions_response` with array of session objects
- Can be hidden via `claudeCode.hideOnboarding` (uses `getHiddenSessionIds()`)
- Context key `claude-vscode.sessionsListEnabled` controls the session sidebar visibility

### Reopen Closed Session (Cmd+Shift+T)

Enabled by default. Uses the context key `claude-vscode.lastClosedWasSession` to only intercept when Claude was the last closed tab — otherwise passes through to VS Code's native behavior.

---

## 13. Plugin System

Commands: `installPlugin`, `list_plugins`, `set_plugin_enabled`, `uninstall_plugin`

Messages: `list_marketplaces`, `add_marketplace`, `remove_marketplace`, `refresh_marketplace`

The plugin system has its own marketplace concept with install/uninstall flows triggered from the webview UI.

---

## 14. Onboarding

### Walkthrough (4 Steps)

1. **Welcome** — explains Claude Code capabilities
2. **Open Claude** — shows the orange icon + Cmd+Escape shortcut. Completion events: `onCommand:claude-vscode.sidebar.open` or `onCommand:claude-vscode.editor.open`
3. **Chat** — explains @-mentions, selection highlighting, Enter-to-send
4. **Sessions** — explains past conversations, `/resume`, new chat

Each step has a `markdown` media file referencing a screenshot.

### Onboarding Checklist (In-WebView)

An in-chat checklist with dismissable items:
- Highlight text
- Accept mode
- Plan mode

Controlled by `claudeCode.hideOnboarding` setting + `dismiss_onboarding` message type.

---

## 15. What Claude Does Particularly Well

### ✅ Adopt These Patterns

1. **`--app-*` CSS variable abstraction layer** — Map every VS Code token to a semantic app variable once, then only reference app variables in component CSS. This is the single best practice in the entire extension.

2. **Dual-location support** (sidebar vs panel) — Let the user choose where Claude lives. Use `preferredLocation` config that auto-updates when the user drags the panel. Both `createWebviewPanel` and `registerWebviewViewProvider` with the same core webview.

3. **Context-aware Cmd+Escape toggle** — Single shortcut for focus/blur based on whether the user is in the editor or in Claude. Feels like a natural "summon/dismiss" gesture.

4. **Opt-in Cmd+N for new conversation** — Default-off to avoid stealing VS Code's new-file binding. Smart: only activate when Claude webview is focused.

5. **Cmd+Shift+T session reopen with fallthrough** — Only intercepts when the last closed tab was Claude; otherwise passes through to VS Code. Respectful of existing muscle memory.

6. **Diff view delegation** — Claude doesn't build its own diff viewer. It uses `vscode.diff` command, adds Accept/Reject toolbar buttons via `editor/title` menu contributions, and manages state with context keys.

7. **Permission mode picker** — QuickPick-based mode selector (default / acceptEdits / plan / bypassPermissions). First-class UX for the trust gradient.

8. **Onboarding walkthrough** — 4-step native VS Code walkthrough with completion events. In-webview checklist for feature discovery.

9. **Inline codicon font** — Zero network dependency, always works offline, matches VS Code's native icon set.

10. **`retainContextWhenHidden: true` everywhere** — WebView state survives tab switches. No re-rendering when the user comes back.

### ⚠️ Patterns to Note (Not Necessarily Copy)

- **144 postMessage types** — This is high coupling. The webview knows about every Claude binary feature. Consider a cleaner protocol boundary.
- **No VS Code ChatParticipant** — Claude doesn't use the built-in VS Code chat API at all. This means no integration with other chat participants, no shared chat history.
- **No inline decorations** — All interaction is panel-based. Users who like inline editing won't find it here.
- **370KB minified CSS bundle** — Even for a feature-rich webview, this is heavy. The CSS modules approach scopes styles but doesn't tree-shake unused rules well.

### 🔴 Gaps for OpenClaw VSCode

1. **No keybindings** — Claude ships 8 thoughtful defaults; we ship none
2. **No status bar** — Claude has a minimal presence indicator
3. **No walkthrough/onboarding** — Claude guides new users through features
4. **No session reopen** — Claude's Cmd+Shift+T is sticky and smart
5. **No @-mention from editor** — Claude's Alt+K is a key differentiator
6. **No location switching** — Claude supports sidebar AND panel; we're sidebar-only
7. **Categories: "Other"** — Claude uses "AI", "Chat" which improves Marketplace discoverability
8. **No diff workflow** — Claude's accept/reject pattern is polished
9. **No permission modes** — Claude's trust gradient UX is missing from OpenClaw
