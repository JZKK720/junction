# Codex (OpenAI ChatGPT) VSCode Extension — UX Audit

**Version:** 26.5527.31454  
**Date:** 2026-05-31  
**Engine:** VS Code ^1.96.2  
**Size:** ~330 MB installed (bundles full CLI runtime)

---

## Summary Comparison Table

| UX Pattern | Codex | OpenClaw VSCode (current) | Gap |
|---|---|---|---|
| **Activation** | `onStartupFinished` + `onUri` | `onStartupFinished` | Parity |
| **Chat surface** | Webview sidebar + detached editor panels | Webview sidebar + chat participant | Codex richer panels |
| **Chat participant** | ❌ None | ✅ `openclaw.agent` (sticky) | OpenClaw ahead |
| **Inline chat** | ❌ None | ❌ None | Both missing |
| **Inline CodeLens** | ✅ TODO → "Implement with Codex" | ❌ None | Big gap |
| **Secondary sidebar** | ✅ Primary + secondary fallback | ✅ Secondary only | Codex more resilient |
| **Custom editors** | ✅ Conversations as editor tabs | ❌ None | Gap |
| **Status bar** | ❌ None | ✅ Connection indicator | OpenClaw ahead |
| **Model picker** | Webview dropdown (tier-based) | N/A (gateway-managed) | Different model |
| **File context** | `@` mentions + context menus | Auto-send active file | Different approach |
| **Keybindings** | 1 (Ctrl+N hijack) | 0 default | Codex clever |
| **CSP** | Dynamic runtime injection | Static HTML | Codex better |
| **retainContextWhenHidden** | `true` (all views) | Unknown (need check) | Codex safer |
| **Theme system** | ~30 built-in themes, design tokens | VS Code tokens only | Massive gap |
| **UI framework** | React + Tailwind CSS v4 | Native HTML/CSS | Codex richer |
| **Composer UX** | Footer bar, above-composer suggestions, container queries | Plain input | Massive gap |
| **Thread following** | ✅ Follower webviews with permissions | ❌ None | Feature gap |
| **Worktree/filesystem** | ✅ Managed sandbox worktrees | ❌ None | Feature gap |
| **Startup experience** | Shimmer animation, reduced-motion respect | (unknown) | Codex polished |
| **Multi-view** | Sidebar + editor panels + secondary sidebar, all share same webview code | Sidebar + chat participant, separate code paths | Codex more unified |
| **Onboarding/NUX** | ✅ Multi-state NUX with temporary state | ❌ None (gateway configured once) | Acceptable difference |
| **Plan mode** | ✅ Collaboration mode toggle | ❌ None | Feature gap |
| **Diff rendering** | ✅ Custom diff panel with color/symbol markers | ❌ None | Feature gap |
| **Code review** | ✅ `/review` inline or detached | ❌ None | Feature gap |

---

## 1. Package.json — Full UX Surface Area

### Commands (9 total, 1 experimental, 2 debug)

| Command | Surface | Notes |
|---|---|---|
| `chatgpt.implementTodo` | CodeLens only (enablement: `false`) | Triggered from TODO comment CodeLens |
| `chatgpt.openSidebar` | Editor title bar + command palette | Has light/dark blossom icon |
| `chatgpt.openCommandMenu` | Command palette | Delegates to `workbench.action.showCommands` (VS Code palette) |
| `chatgpt.newCodexPanel` | Chat sessions "newSession" menu | Opens conversation as editor tab |
| `chatgpt.addToThread` | Editor context menu | When `resourceScheme == file` |
| `chatgpt.addFileToThread` | Editor tab context menu | Adds entire file to thread |
| `chatgpt.newChat` | Sidebar webview context menu + keybinding | New thread |
| `chatgpt.showLspMcpCliArgs` | Command palette (conditional) | Only when LSP MCP enabled |
| `chatgpt.dumpNuxState` / `chatgpt.resetNuxState` | Debug only | When sidebar visible |

### View Containers (graceful fallback pattern)

```
Primary sidebar (activity bar):  when chatgpt.doesNotSupportSecondarySidebar
Secondary sidebar:               when !chatgpt.doesNotSupportSecondarySidebar
```

This is excellent UX — detects VS Code version and uses the best sidebar available. Falls back to activity bar if secondary sidebar API unavailable.

The `doesNotSupportSecondarySidebar` context key is set by checking VS Code version ≥ 1.96.2 against a threshold where secondary sidebar became stable.

### Views

Both are `type: "webview"` — no tree views:
- `chatgpt.sidebarView` → primary sidebar
- `chatgpt.sidebarSecondaryView` → secondary sidebar

Same provider instance services both.

### Custom Editors

```json
chatgpt.conversationEditor → "Codex Task"
  priority: "default"
  selector: { filenamePattern: "openai-codex:/**/*" }
```

This is a major UX pattern: conversations can be opened as full-fledged editor tabs alongside code. The editor title bar shows conversation preview + model provider. Clicking a conversation from the chat sessions list opens it as an editor tab.

### chatSessions Contribution

```json
{ type: "openai-codex", name: "Codex", displayName: "OpenAI Codex" }
```

Integrates with VS Code's chat sessions API. The `chatSessions/newSession` menu creates new Codex panels.

### Grammars & Languages

Custom `codex-rules` language (Starlark), mapping `.rules` extensions. This means Codex ships its own syntax highlighting for configuration/rule files.

### Configuration Properties (8 settings)

| Setting | Type | Default | Scope |
|---|---|---|---|
| `chatgpt.commentCodeLensEnabled` | boolean | `true` | — |
| `chatgpt.cliExecutable` | string\|null | `null` | application (restricted) |
| `chatgpt.openOnStartup` | boolean | `false` | — |
| `chatgpt.followUpQueueMode` | queue\|steer\|interrupt | `queue` | — |
| `chatgpt.composerEnterBehavior` | enter\|cmdIfMultiline | `enter` | — |
| `chatgpt.reviewDelivery` | inline\|detached | `inline` | — |
| `chatgpt.localeOverride` | string\|null | `null` | application |
| `chatgpt.runCodexInWindowsSubsystemForLinux` | boolean | `false` | — |

Key observation: **only 8 settings exposed to users.** Most configuration is handled inside the webview UI (theme, model, font size, etc.) via `persisted-atom` state synced between webview and extension.

---

## 2. WebView Architecture

### Entry Point

`webview/index.html` — single HTML file with placeholder markers:
- `<!-- PROD_BASE_TAG_HERE -->` → replaced with `<base href>` at runtime
- `<!-- PROD_CSP_TAG_HERE -->` → replaced with `<meta http-equiv="Content-Security-Policy">` at runtime

This allows the CSP to be generated dynamically using VS Code's `cspSource`:

```
default-src ${cspSource} https: data: blob:
script-src ${cspSource}
style-src ${cspSource} 'unsafe-inline'
font-src ${cspSource}
connect-src ${cspSource} ${externalSources}
```

### Resource Loading

- All webview assets are in `webview/assets/` with hashed filenames (Vite/Rollup bundling)
- Preloaded via `<link rel="modulepreload">` — ensures fast JS loading
- Entry point: `index-DaxayE40.js`
- All resources inside `localResourceRoots: [webviewUri]`

### Webview Options

```
Sidebar view:         { webviewOptions: { retainContextWhenHidden: true } }
Secondary sidebar:    { webviewOptions: { retainContextWhenHidden: true } }
Custom editor panels: { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [...] }
```

**both `retainContextWhenHidden: true`** — the webview stays alive when hidden, preserving conversation state.

### Multi-View Architecture

One `CodexWebviewProvider` instance serves ALL views:
- Sidebar webview
- Secondary sidebar webview  
- Multiple editor panel webviews
- Multiple conversation editor webviews

Communication is unified. Messages are broadcast to all views or targeted to specific ones. This is architecturally clean — single codebase, single state synchronization.

### Startup Experience

The HTML includes an inline shimmer loading animation:
- SVG Codex blossom logo
- CSS shimmer overlay effect (2.2s cubic-bezier loop)
- Fade-in animation (180ms)
- Respects `prefers-reduced-motion: reduce` — disables all animations

### UI Framework

- **React** (compiled JSX, minified)
- **Tailwind CSS v4.2.4** — utility-first CSS with container queries
- **ProseMirror** — rich text editor for the composer (not plain textarea)
- **Radix UI** — dropdown menus, tooltips (via `dropdown-*.css`, `data-radix-*` attributes)
- **CodeMirror/cmdk** — command palette / search UI patterns

---

## 3. Chat Flow

### Message Input (Composer)

The composer is a rich text input at the bottom of the sidebar/panel:

```
┌──────────────────────────────────────┐
│  [Above-composer suggestions]        │ ← context-aware
│  ┌────────────────────────────────┐  │
│  │ ProseMirror editor             │  │ ← supports @mentions, formatting
│  │                                │  │
│  └────────────────────────────────┘  │
│  [Model ▾] [Context+] [Enter behavior]│ ← composer footer
└──────────────────────────────────────┘
```

**Key features:**
- **ProseMirror** for rich editing (not plain textarea)
- **Above-composer suggestions** — contextual pills like "Create a plan (Shift+Tab)" that appear based on typed content (e.g., typing "plan" suggests Plan mode)
- **Footer bar** with model picker dropdown, context attachment button, settings
- **Container queries** for responsive layout — labels hide based on available width

### Enter Behavior

Configurable via `chatgpt.composerEnterBehavior`:
- `enter` — Enter sends immediately
- `cmdIfMultiline` — Enter inserts newline, Cmd/Ctrl+Enter sends

### Thread Management

- **New thread**: `Ctrl+N` (overrides VS Code "new file" when sidebar focused) or webview context menu
- **Thread list**: Sidebar shows conversation history with summaries and model badges
- **Thread following**: Webviews can "follow" threads — followers get turn-by-turn status but limited control
- **Thread naming**: Automatic naming from first message content

### No Chat Participant

Codex does NOT use VS Code's chat participant API. All chat is in the webview. This means:
- No inline chat in the VS Code chat panel
- No slash commands in the native chat interface
- Everything is a custom UI

### No Inline Chat

Zero inline chat support. No `InlineChatProvider`, no editor decorations for chat. All interaction requires the sidebar or a detached panel.

---

## 4. Theme & Styling

### Design Token System

Codex uses its own CSS variable design token system, NOT VS Code theme tokens:

```css
--color-token-text-primary
--color-token-text-secondary
--color-token-bg-primary
--color-token-bg-secondary
--color-token-side-bar-background
--color-token-dropdown-background
--color-token-border
--color-token-border-light
--color-token-input-placeholder-foreground
--color-token-list-hover-background
--color-token-text-code-block-background
--color-token-terminal-ansi-*
```

### Built-in Themes (~30+)

Codex ships with a large built-in theme library:

```
Codex, GitHub, Dracula, Nord, Vercel, Xcode, Rose Pine, Solarized,
Tokyo Night, Monokai, Material, Notion, Linear, Gruvbox, Catppuccin,
Everforest, Matrix, Lobster, Raycast, Sentry, Temple, One, Proof,
Oscurange, VSCode Plus, Night Owl, Ayu, Absolutely
```

### Theme Architecture

Themes are separated into **chrome themes** (UI) and **code themes** (syntax highlighting):

```
appearanceTheme:            system | light | dark
appearanceLightChromeTheme:  Chrome theme object (surface, ink, accent, semantic colors)
appearanceDarkChromeTheme:   Chrome theme object
appearanceLightCodeThemeId:  Code theme ID (from ~30 options)
appearanceDarkCodeThemeId:   Code theme ID
```

Chrome themes are structured objects:
```typescript
{
  accent: "#hex",
  contrast: number (0-100),
  fonts: { code: string|null, ui: string|null },
  ink: "#hex",
  opaqueWindows: boolean,
  semanticColors: { diffAdded: "#hex", diffRemoved: "#hex", skill: "#hex" },
  surface: "#hex"
}
```

### Font Control

```
sansFontSize: 14    (base UI font)
codeFontSize: 12    (code font)
useFontSmoothing: true
```

Also reads VS Code's `chat.fontSize` and `chat.editor.fontSize` settings.

### Diff Markers

```json
"appearanceDiffMarkerStyle": "color" | "symbols"
```

### Accessibility

```
usePointerCursors: false      (accessibility: avoids pointer cursors)
reducedMotionPreference: system | on | off
```

### CSS Architecture

- **Tailwind CSS v4.2.4** — utility classes for layout
- **CSS Modules** — scoped `.module` classes for component-specific styles
- **Container queries** — `@container composer-footer (width <= 440px)` for responsive composer
- **Radix animation conventions** — `data-state="open"`, `data-side="top"` for dropdowns

---

## 5. Model Picker

### Architecture

Model selection is **entirely webview-based**, not VS Code QuickPick or settings:

1. **Service tier system** — models are grouped into speed tiers:
   - `fast` tier
   - Default tier
   - Enterprise default
   
2. **Per-thread model selection** — stored in thread settings, synced via IPC

3. **Composer footer dropdown** — model picker lives in the composer's top menu chrome (footer bar)

4. **Settings panel** — users can set preferred service tier and model

5. **Followers request changes** — follower webviews can request model changes via `thread-follower-set-model-and-reasoning` IPC

### Model Rendering

Models are loaded from the Codex app server (bundled CLI), not from VS Code settings. The model list is fetched and rendered in the webview with:
- Model name/display
- Speed tier badge
- Available capabilities

---

## 6. File Context

### `@` Mention System

The composer supports inline `@` mentions for files. When `@` is typed:
1. A mention search popup appears
2. Files from the workspace are suggested
3. Selecting a file attaches it as context

### Context Menu Integration

Two right-click workflows:
- **Selection → "Add to Codex Thread"** (`editor/context` menu) — sends selected text as context
- **Tab → "Add File to Codex Thread"** (`editor/title/context` menu) — sends entire file

### Workspace File Tree

A directory-tree component in the webview shows the workspace structure for context selection.

### Active Workspace

Extension monitors `onDidChangeWorkspaceFolders` and broadcasts `active-workspace-roots-updated` to all views.

### CodeLens — TODO Comments

When `chatgpt.commentCodeLensEnabled` is enabled:
- Scans for TODO comments
- Adds "Implement with Codex" CodeLens above them
- Clicking sends the file, line, and comment to Codex

```
// TODO: refactor this to use async/await
//   ↑ "Implement with Codex"  ← CodeLens
```

### No Auto-Attach

Unlike OpenClaw's `autoSendFileContext`, Codex does NOT automatically attach the active editor. All context attachment is explicit.

---

## 7. Activation

**Activation events:**
```
onStartupFinished   — activates as soon as VS Code finishes loading
onUri               — handles openai-codex: URI scheme for custom editors
```

**No lazy activation.** The extension starts with VS Code. Given its size (~330MB), this means significant startup cost, but ensures immediate availability.

Context keys set during activation:
```
chatgpt.sidebarView.visible
chatgpt.doesNotSupportSecondarySidebar
chatgpt.supportsNewChatKeyShortcut
chatgpt.supportsNewChatMenu
chatgpt.lspMcpEnabled
```

---

## 8. Status Bar

**No status bar items.** Zero `StatusBarItem` references in the entire extension. All status, progress, and connection state is shown inside the webview.

---

## 9. Keyboard Shortcuts

### Default Keybinding

Only ONE default keybinding:

```
chatgpt.newChat → Ctrl+N / Cmd+N
  when: chatgpt.supportsNewChatKeyShortcut
```

The context key `chatgpt.supportsNewChatKeyShortcut` is set only when the Codex webview has focus. This cleverly **overrides VS Code's native "New File" shortcut** only when the user is focused on Codex.

### Composer Shortcuts

- `Shift+Tab` — interact with above-composer suggestions (e.g., enable Plan mode)
- `Cmd/Ctrl+Enter` — opposite of configured enter behavior (send when enter inserts newline, or insert newline when enter sends)
- `Cmd/Ctrl+Shift+Enter` — queue vs. steer override for follow-ups

---

## 10. Inline vs. Panel

### Panel-Based ONLY

Codex is entirely panel-based:
- **Sidebar webview** — primary interaction surface
- **Detached editor panels** — conversations opened as full editor tabs via custom editor
- **Hotkey window** — popout window for quick chat

### What's Missing

| Feature | Present? |
|---|---|
| Inline chat in editor | ❌ |
| VS Code chat participant | ❌ |
| Editor decorations for chat | ❌ |
| Inline completions (like Copilot) | ❌ |
| CodeLens for TODOs | ✅ |
| Context menu "Add to thread" | ✅ |

### Custom Editor Panels

Conversations open as editor tabs using VS Code's custom editor API:
```
viewType: "chatgpt.conversationEditor"
displayName: "Codex Task"
selector: openai-codex:/**/*
```

This means conversations can exist alongside files in the tab bar, with their own title, icon, and persistence.

### Hotkey Window

A separate popout window (`/hotkey-window`) accessible via a global shortcut for quick interactions outside the main VS Code window.

---

## Key UX Patterns Worth Adopting

### 1. Above-Composer Suggestions ⭐⭐⭐⭐⭐

Contextual suggestion pills that appear above the input:

```
┌──────────────────────────────────────┐
│  🎯 Create a plan    Shift+Tab   [×] │ ← suggestion pill
│  ┌────────────────────────────────┐  │
│  │ I want to build a plan for...   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

Driven by keyword matching in the input text. Can be dismissed and never shown again. Has an action button and a dismiss button.

**For OpenClaw:** Could suggest "send file context", "search for X", or slash commands.

### 2. Composer Footer Bar ⭐⭐⭐⭐⭐

A persistent footer bar below the input with contextual controls:

```
[Model: GPT-5 ▾]  [Fast mode]  [@ Context +]  [Enter ▾]
```

Uses CSS container queries for responsive behavior — labels auto-hide on narrow widths.

**For OpenClaw:** Could show current model, session, context files count.

### 3. Conversation as Editor Tab ⭐⭐⭐⭐

Opening conversations as full editor tabs via custom editor API:

```
[📄 main.ts]  [💬 Codex: Refactor auth]  [📄 config.ts]
```

This lets users dedicate full editor space to long conversations.

**For OpenClaw:** Straightforward VS Code API; adds a second interaction surface.

### 4. Thread Follower System ⭐⭐⭐⭐

Webviews can "follow" threads with tiered permissions:
- Owner: full control
- Follower: can steer, interrupt, change model, submit input
- The system uses IPC request/response with request IDs and timeouts

**For OpenClaw:** Could enable multi-panel workflows where a sidebar monitors an editor-panel conversation.

### 5. Ctrl+N Hijack ⭐⭐⭐⭐

Overrides VS Code's "New File" shortcut only when the chat webview is focused:

```json
{ "command": "chatgpt.newChat", "key": "ctrl+n",
  "when": "chatgpt.supportsNewChatKeyShortcut" }
```

Simple, effective. Users don't accidentally create new files when they mean to start a new chat.

### 6. Sidebar Fallback Strategy ⭐⭐⭐⭐

Detects VS Code version and uses the best available sidebar:

```
Version < 1.96.2  → Activity bar (primary sidebar)
Version ≥ 1.96.2  → Secondary sidebar
```

Context key: `chatgpt.doesNotSupportSecondarySidebar`

### 7. Dynamic CSP Injection ⭐⭐⭐

CSP injected at runtime using VS Code's `cspSource`:

```html
<!-- PROD_CSP_TAG_HERE --> → <meta http-equiv="Content-Security-Policy" content="...">
```

This allows the extension to add runtime-specific sources (e.g., external API domains for OAuth) without hardcoding.

### 8. Shimmer Loading Animation ⭐⭐⭐

Polished startup with SVG logo + CSS shimmer, respecting `prefers-reduced-motion`. Simple but effective first impression.

### 9. Persisted Atom State ⭐⭐⭐

Global state synchronized between webview and extension via typed events:

```
persisted-atom-update    (webview → extension)
persisted-atom-sync      (extension → webview)
persisted-atom-reset     (clear all)
```

Used for theme, model preferences, dismissed suggestions, etc.

### 10. Service Tier Model Organization ⭐⭐⭐

Instead of a flat list of model names, models are grouped into speed/capability tiers. Users pick a tier, not a specific model ID. This simplifies the UX significantly.

---

## Architecture Notes

### Extension ↔ Webview Communication

Codex uses a typed postMessage protocol:

```
Webview → Extension:  { type: "ready" }
                      { type: "persisted-atom-update", key, value }
                      { type: "thread-follower-start-turn-request", ... }

Extension → Webview:  { type: "persisted-atom-sync", state }
                      { type: "chat-font-settings", chatFontSize, chatCodeFontSize }
                      { type: "navigate-to-route", path, state }
                      { type: "add-context-file", file }
                      { type: "active-workspace-roots-updated" }
```

Message types include: `ready`, `navigate-to-route`, `add-context-file`, `implement-todo`, `new-chat`, `chat-font-settings`, `persisted-atom-*`, `shared-object-updated`, `codex-app-server-fatal-error`, `mcp-request`, `custom-prompts-updated`, and 20+ IPC request/response types for thread following.

### Bundled Backend

Codex ships a full CLI backend (`bin/linux-x86_64/codex*`) that runs as a subprocess:
- Manages models, MCP servers, filesystem sandboxes (worktrees)
- Communicates via a typed RPC protocol
- Processes exit with crash context for error reporting

### IPC Layer

A full IPC client system with:
- Request/response with timeouts
- Broadcast channels
- Webview-specific client registries
- Thread role resolution (owner/follower)
- Multiple pending-request maps with cleanup

---

## Open Recommendations for OpenClaw VSCode

### Immediate Wins (Low Effort)

1. **Add `retainContextWhenHidden: true`** to webview options — prevents chat state loss when switching tabs
2. **Dynamic CSP generation** — replace static CSP with runtime injection for flexibility
3. **Sidebar fallback** — detect secondary sidebar availability, fall back to activity bar
4. **Ctrl+N hijack** — override new-file shortcut when chat focused → new chat instead

### Medium Effort

5. **Composer footer** — add a thin footer bar below the input with:
   - Model/agent indicator
   - Context file count badge
   - Send mode toggle (Enter vs Cmd+Enter)
6. **Above-composer suggestions** — keyword-driven suggestion pills for common actions
7. **Persisted atom state** — sync theme/settings between webview and extension properly
8. **Shimmer/loading animation** — polished startup with reduced-motion support

### Larger Investments

9. **Custom editor for conversations** — open chats as full editor tabs
10. **Built-in theme system** — design tokens for Codex-level polish (can start with just 3-4 themes)
11. **Container-query responsive composer** — auto-hide labels on narrow widths
12. **CodeLens integration** — "Send to OpenClaw" above TODO/FIXME comments

### What NOT to Copy

- The 330MB bundled CLI backend — unnecessary for OpenClaw's gateway model
- The thread follower IPC complexity — only needed for multi-panel coordination
- The worktree filesystem sandbox — OpenClaw runs commands differently
- The ProseMirror rich text editor — plain textarea is fine for MVP
