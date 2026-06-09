# UX Feature Catalog — AI-Powered VS Code Extension

A source-agnostic product requirements document synthesizing UX capabilities from multiple AI coding assistant extensions into a single unified feature set. Every item below is presented as a configurable setting, capability, or UX behavior of one cohesive application.

---

## 1. Chat Surface

### Conversation Viewports
- **Sidebar chat view** — Primary interaction surface in the VS Code sidebar (activity bar or secondary sidebar), with `retainContextWhenHidden: true` to preserve conversation state across tab switches.
- **Editor-tab conversations** — Conversations openable as full editor tabs via VS Code's custom editor API, appearing alongside source files in the tab bar with title, icon, and persistence.
- **Detached panel mode** — Chat opens in a resizable VS Code bottom panel or editor panel, user-switchable via a `preferredLocation` setting.
- **New-window conversations** — Chat can be detached into a separate VS Code window for dedicated focus or multi-monitor setups.
- **Terminal mode** — Chat accessible from the integrated terminal for CLI-oriented workflows.
- **Primary editor mode** — Chat opens in the main editor group, replacing or alongside source files.
- **Hotkey popout window** — A lightweight popout window triggered by a global shortcut for quick chat interactions without leaving the main editor.
- **Dual-location support** — The user can drag the chat between sidebar and panel, with the extension auto-detecting the new location and updating state.

### Multi-View Coordination
- **Single-provider architecture** — All chat views (sidebar, editor tabs, panels) are backed by the same webview provider, sharing state and message protocol.
- **Thread following** — A webview can "follow" a conversation owned by another view, receiving turn-by-turn status with tiered permissions (owner: full control; follower: steer, interrupt, change model, submit input).
- **Conversation listing** — A sidebar showing conversation history with auto-generated summaries, model badges, and the ability to search, rename, delete, or fork any conversation.

### Rendering & Content Types
- **Rich message rendering** — Supports text, code blocks, tool-call cards, tool-result blocks, diffs, headings, links, images, and tables in the chat flow.
- **Tool-use cards** — Full-width card-style rendering for agent tool invocations (file operations, shell commands, browser actions).
- **Tool-result blocks** — Monospaced, scrollable `<pre>` blocks for tool output, styled with a code-background token.
- **Plan-mode previews** — Before executing a plan, the agent renders a preview card that the user can approve, modify, or close.
- **Permission-request cards** — Inline tool-approval cards shown within the chat (not native VS Code notifications), with accept/reject/always-allow controls.
- **Review-upsell banner** — A contextual banner prompting the user to try accept-edits mode for a smoother diff-review workflow.
- **Terminal-mode banner** — A contextual banner suggesting the terminal mode to users who frequently use CLI-style interactions.
- **In-webview status indicators** — All connection state, progress, and agent activity shown inside the chat webview.

---

## 2. Input Composer

### Editor Surface
- **Rich-text composer** — A ProseMirror-backed rich text editor supporting formatting, `@`-mentions, and embedded context references, not a plain textarea.
- **Plain-text mode** — Option to fall back to a standard textarea for simplicity or accessibility.

### Send Behavior
- **Enter-to-send** — Pressing Enter sends the message immediately (default).
- **Ctrl/Cmd+Enter to send** — A configurable setting (`useCtrlEnterToSend`) that makes Enter insert a newline and Ctrl/Cmd+Enter send.
- **Smart Enter** — A `composerEnterBehavior` setting with `enter` (send on Enter) and `cmdIfMultiline` (send on Enter only when the input is a single line; multiline inputs require Ctrl/Cmd+Enter).

### Suggestion System
- **Above-composer suggestions** — Contextual suggestion pills that appear above the input based on keyword matching in the typed text. Examples: "Create a plan (Shift+Tab)", "Attach current file", "Search workspace."
- **Suggestions are dismissible** — Each pill has a dismiss button; once dismissed, that suggestion never appears again.
- **Suggestions have actions** — Each pill includes a shortcut-triggerable action, e.g., pressing Shift+Tab activates the top suggestion.

### Composer Footer Bar
- **Model/agent indicator** — Shows the currently selected model or agent in a dropdown within the footer.
- **Context-file count badge** — Displays the number of attached context files.
- **Send-mode toggle** — Dropdown to switch between Enter-to-send and Ctrl+Enter-to-send.
- **Responsive layout** — Labels auto-hide on narrow viewports using CSS container queries (e.g., `@container composer-footer (width <= 440px)`).

### Mention & Context System
- **`@`-mention autocomplete** — Typing `@` in the composer triggers a file/folder autocomplete popup sourced from the workspace file tree.
- **Mention chips** — Attached files render as styled inline chips (background/foreground mapped to VS Code chat command tokens), clickable to remove or view, with hover highlight.
- **Selection-based mention** — Highlight text in the editor and invoke the mention command to insert `@filepath:startLine-endLine` into the composer.
- **Context-menu attachment** — Right-click a selection in any editor → "Add to Thread" sends the selected text. Right-click an editor tab → "Add File to Thread" sends the entire file.
- **Workspace file tree** — A directory-tree component in the sidebar webview for browsing and attaching files/folders without typing.
- **Manual context add** — A "+" button in the composer footer opens a file picker for context attachment.

---

## 3. File Context

### Attachment Methods
- **`@`-mention from composer** — Type `@` and select from an autocomplete list of workspace files and folders.
- **`@`-mention from editor** — A keyboard shortcut inserts the current file (with optional selection range) as an `@`-mention in the composer.
- **Context menu "Add to Thread"** — Available in the editor context menu when text is selected.
- **Context menu "Add File to Thread"** — Available in the editor tab context menu.
- **Workspace file-tree picker** — A visual directory tree in the chat sidebar for drag-and-drop or click-to-attach file context.
- **Active-workspace monitoring** — The extension watches `onDidChangeWorkspaceFolders` and broadcasts updated workspace roots to all views.

### Context Rendering
- **Mention chips** — Attached references render as inline styled chips using VS Code chat-token colors, clickable with cursor pointer and brightness hover.
- **Selection-range encoding** — Context references include line ranges: `@path/to/file:10-25`.
- **Tool-reference display** — When a tool operation references a file, a secondary-foreground colored label shows the referenced file path.

### CodeLens Integration
- **TODO comment CodeLens** — When `commentCodeLensEnabled` is true, scans for `TODO`, `FIXME`, `HACK` comments and adds a "Implement with Assistant" CodeLens above them. Clicking sends the file, line, and comment text to the agent.
- **Toggle setting** — `commentCodeLensEnabled` can be enabled/disabled in VS Code settings.

### Auto-Attach
- **Auto-send active file** — An `autoSendFileContext` setting that periodically pushes the active editor's content as context without manual attachment (configurable interval).
- **Off by default** — Explicit attachment is the default; auto-attach is opt-in.

---

## 4. Model Selection

### Picker Interfaces
- **Native QuickPick picker** — Model selection via VS Code's native QuickPick API for keyboard-first navigation, fuzzy search, and automatic theming.
- **Webview dropdown picker** — Model selection via a dropdown in the composer footer bar.
- **Settings-panel model config** — A dedicated settings panel for choosing preferred models, service tiers, and capabilities.

### Model Organization
- **Service-tier grouping** — Models organized into capability tiers (e.g., "Fast," "Default," "Reasoning") rather than a flat list of opaque model IDs.
- **Per-conversation model** — Each conversation/thread stores its own model selection, persisted across sessions.
- **Current-model badge** — The active model name displayed in the composer footer or header area.

### Reasoning & Thinking
- **Reasoning/thinking level** — Configurable thinking depth or budget for models that support extended reasoning.
- **Tier-permission inheritance** — Follower webviews can request model changes via IPC without needing owner-level access.

---

## 5. Diff & Edits

### Diff Viewing
- **Native VS Code diff editor** — Proposed file changes open in VS Code's built-in diff editor, not a custom rendering.
- **Custom diff panel** — An in-webview diff panel with color-coded additions (green) and removals (red), configurable as either color-coded or symbol-marked.
- **Diff marker style** — Configurable: `color` (background highlights) or `symbols` (gutter markers like `+`/`-`).

### Accept/Reject Workflow
- **Toolbar accept button** — An "Accept" button in the diff editor toolbar (navigation group), visible only when a proposed diff is being viewed.
- **Toolbar reject button** — A "Reject" button in the same location.
- **Context-key gating** — The accept/reject buttons appear only when the context key `viewingProposedDiff` is set, which is managed by the extension when it opens a diff.
- **Command palette access** — Accept/reject available as commands in the palette as well.

### Review Mode
- **Inline review** — When a `/review` command is issued, changes display as inline annotations within the chat.
- **Detached review** — Changes open in a separate diff view. Controlled by a `reviewDelivery` setting (`inline` vs `detached`).

---

## 6. Sessions & Conversations

### Session Management
- **Dedicated sessions sidebar** — A webview sidebar listing all past conversations with summaries, model badges, and timestamps.
- **Rename sessions** — Inline or context-menu rename for any conversation.
- **Delete sessions** — Remove conversations from the list (soft delete with recovery option).
- **Fork conversations** — Branch a conversation at a specific message to explore alternative paths without losing the original.
- **Teleport to session** — Jump the current conversation to a specific point in a past session.
- **Hidden sessions** — A list of session IDs that are hidden from the sidebar, with controls to unhide.

### Reopen & Resume
- **Reopen closed session** — A keyboard shortcut that reopens the most recently closed conversation, using a context key to only intercept when the last closed tab was a conversation (otherwise the shortcut falls through to VS Code's native reopen-editor behavior).
- **`/resume` command** — A slash command to resume a past conversation by name or search.
- **Smart reopen** — A command that remembers whether the user last viewed the chat in sidebar or panel and reopens in the same location.
- **Past Conversations button** — A button in the chat header that opens the session list.

### New Conversation
- **New Conversation command** — Available in the command palette, webview context menu, and via keyboard shortcut.
- **Opt-in shortcut** — A keyboard shortcut for new conversation that is off by default to avoid overriding VS Code's native "New File" shortcut; when enabled, it only activates when the chat webview is focused.
- **Conversation auto-naming** — Conversations are automatically titled from the first message content.

---

## 7. Keybindings

### Focus & Navigation
- **Focus chat** — A single shortcut that toggles focus between the editor and the chat input, context-aware: when in an editor, focus moves to chat; when in chat, focus returns to editor.
- **Open chat in tab** — Opens the chat in a new editor tab.
- **Open chat in new window** — Detaches the chat into a separate VS Code window.
- **Smart reopen** — Reopens chat in the last-used location (sidebar, panel, or tab).

### Context & Mentions
- **Insert `@`-mention from editor** — When the editor has focus, inserts the current file (with selection range if text is highlighted) as an `@`-mention in the composer.
- **Secondary mention shortcut** — Alternative keybinding for terminal-mode users.

### Conversation Control
- **New conversation** — Creates a new conversation (overrides VS Code's native "New File" shortcut only when the chat webview is focused).
- **Reopen closed conversation** — Reopens the most recently closed conversation.
- **Above-composer suggestion activation** — Focuses and triggers the top suggestion pill above the composer input.
- **Opposite send behavior** — When Enter sends, Ctrl/Cmd+Enter inserts a newline; when Enter inserts a newline, Ctrl/Cmd+Enter sends.
- **Follow-up queue/steer override** — Ctrl/Cmd+Shift+Enter overrides the configured follow-up mode (queue vs. steer).

### Diff Management
- **Accept proposed changes** — Accepts changes currently shown in the diff editor.
- **Reject proposed changes** — Rejects changes currently shown in the diff editor.

---

## 8. Theming & Styling

### Design Token System
- **`--app-*` CSS variable abstraction layer** — A semantic variable layer that maps every VS Code theme token to an application variable. Component CSS references only app variables, never raw VS Code tokens.
- **Semantic token categories:**
  - **Surface tokens** — `--app-primary-background`, `--app-secondary-background`, `--app-menu-background`, `--app-input-background`.
  - **Foreground tokens** — `--app-primary-foreground`, `--app-secondary-foreground`.
  - **Interactive tokens** — `--app-button-foreground`, `--app-button-background`, `--app-button-hover-background`, `--app-accent-color`, `--app-link-foreground`.
  - **List tokens** — `--app-list-hover-background`, `--app-list-active-background`.
  - **Input tokens** — `--app-input-border`, `--app-input-active-border`.
  - **Mention tokens** — `--app-mention-chip-background`, `--app-mention-chip-foreground`.
- **Spacing system** — `--app-spacing-small` (4px), `--app-spacing-medium` (8px), `--app-spacing-large` (12px), `--app-spacing-xlarge` (16px).
- **Corner radii** — `--corner-radius-small` (4px), `--corner-radius-medium` (6px), `--corner-radius-large` (8px).

### Theme Sources
- **VS Code theme alignment** — By default, inherits colors from the active VS Code theme via the `--app-*` mapping layer, ensuring seamless visual integration.
- **Built-in theme library** — Ships with a collection of curated themes (both UI chrome themes and code syntax themes, selectable independently) for users who want a distinct look from their editor theme.

### Light/Dark/High-Contrast
- **Automatic light/dark** — Detects VS Code's `.vscode-light` / `.vscode-dark` body classes; no custom `data-theme` attribute needed. Only 2-3 light-mode variable overrides required.
- **High-contrast support** — Inherits VS Code's `.hc-black` / `.hc-light` classes for accessibility.
- **System color-scheme** — Uses the `color-scheme` CSS property on form elements for native widget theming.

### Typography
- **UI font** — Reads from `--vscode-chat-font-family` and `--vscode-chat-font-size` (default 13px).
- **Code font** — Reads from `--vscode-editor-font-family` (fallback: monospace) and `--vscode-editor-font-size` (default 12px).
- **Configurable font sizes** — Separate `sansFontSize` and `codeFontSize` settings, also responsive to VS Code's `chat.fontSize` and `chat.editor.fontSize` settings.
- **Font smoothing** — Configurable `useFontSmoothing` setting for subpixel antialiasing.

### Iconography
- **Inline codicon font** — The VS Code codicon icon font embedded as a base64 data URI in CSS, requiring zero network requests and always matching VS Code's native icon set.
- **Icon consistency** — All UI icons reference codicon glyphs, never custom SVG sprites.

### CSS Architecture
- **Scoped styles** — CSS Modules with content-hash class suffixes, preventing cross-component style leakage.
- **Utility framework** — Tailwind CSS v4 utility classes for layout and spacing.
- **Container queries** — `@container` rules for responsive component behavior (e.g., hiding labels on narrow containers).
- **Animation conventions** — Dropdown/menu animations using `data-state` and `data-side` attributes (e.g., `data-state="open"`, `data-side="top"`).

### Diff Styling
- **Diff marker style** — Configurable as `color` (green/red background highlights) or `symbols` (gutter markers).

---

## 9. Onboarding & Discovery

### First-Run Experience
- **Multi-step walkthrough** — A 4-step native VS Code walkthrough guiding users through: welcome/introduction, opening the chat, composing a message (mentions, selection, sending), and managing conversations.
- **Step completion events** — Walkthrough steps auto-advance when the user performs the taught action (e.g., step 2 completes when the user opens the sidebar).
- **Shimmer loading animation** — An inline SVG logo with a CSS shimmer overlay (2.2s cubic-bezier loop, 180ms fade-in) shown during webview initialization, respecting `prefers-reduced-motion: reduce`.
- **In-chat checklist** — Dismissable feature-discovery items shown in the conversation view: "Try selecting text in your editor," "Enable accept-edits mode for faster reviews," "Try plan mode for complex changes."
- **Dismissal persistence** — Dismissed onboarding items never appear again, stored in persisted state.

### Feature Discovery
- **Contextual banners** — Non-intrusive banners surfaced in the chat when context suggests the user would benefit from a feature they haven't tried (e.g., "Try terminal mode" for CLI-heavy users, "Try accept-edits mode" during review-heavy sessions).
- **Status-bar presence** — A minimal status-bar item showing the assistant name, which opens the chat on click.
- **Marketplace discoverability** — Extension listed under "AI" and "Chat" categories for visibility in the VS Code Marketplace.

### Settings
- **Minimal exposed settings** — Only ~8 settings surfaced to users via VS Code's Settings UI. Most configuration (theme, model, font size, preferences) is handled inside the webview UI and persisted via atom-state synchronization.

---

## 10. Status Bar

- **Minimal indicator** — A single status-bar item on the right side showing the assistant name (e.g., "✦ Assistant") that opens the chat on click.
- **Smart-open behavior** — Clicking the status bar reopens the chat in the user's last-used location (sidebar, panel, or tab).
- **Location-aware visibility** — The status-bar item shows only when the chat is in sidebar mode; hidden when in panel or tab mode to avoid redundancy.
- **Tooltip** — Hovering shows a descriptive tooltip with the keyboard shortcut for opening the chat.

---

## 11. Activation & Lifecycle

### Startup
- **Eager activation** — Extension activates on `onStartupFinished`, ensuring all commands and views are registered as soon as VS Code finishes loading.
- **Webview-panel activation** — Also activates on `onWebviewPanel` as a fallback for restored sessions.
- **URI activation** — Activates on a custom URI scheme handler for opening conversations as editor tabs.

### Webview Lifecycle
- **`retainContextWhenHidden: true`** — All webviews preserve DOM state and conversation content when the user switches tabs or views. No re-initialization or message re-render on return.
- **Persisted atom state** — Global preferences (theme, model, font size, dismissed suggestions) synchronized between the webview and extension host via typed events: `persisted-atom-update` (webview → extension) and `persisted-atom-sync` (extension → webview).
- **Full state initialization** — On webview ready, the extension sends a complete `init` payload containing authentication status, model settings, preference mode, default working directory, feature flags, and onboarding state.

### Sidebar Detection
- **Version-aware sidebar** — Detects VS Code version and uses the secondary sidebar when available (VS Code ≥1.96.2–1.102), falling back to the activity bar's primary sidebar for older versions.
- **Graceful fallback** — Uses context keys to determine sidebar capability and places views in the best available container.

---

## 12. Panel & View Management

### Location Modes
- **Sidebar mode** — Chat lives in the VS Code sidebar (primary or secondary), sharing space with the file explorer.
- **Panel/tab mode** — Chat opens as a tab in the bottom panel or an editor panel, resizable and rearrangeable.
- **Editor-tab mode** — Conversations open as full editor tabs alongside source files via VS Code's custom editor API, with title, icon, and tab persistence.
- **New-window mode** — Chat opens in a dedicated VS Code window.
- **Terminal mode** — Chat appears as a terminal session.
- **Hotkey window** — A lightweight popout for quick interactions.
- **User-toggleable location** — Users can drag the chat between sidebar and panel; the extension detects the change and updates its `preferredLocation` setting automatically.

### Multi-View Support
- **Single codebase, multiple surfaces** — One webview provider class services all chat views (sidebar, secondary sidebar, editor panels, conversation editors), sharing state and message protocol.
- **Broadcast + targeted messaging** — Messages can be broadcast to all views or targeted to a specific view ID.
- **Thread following** — Views can be designated as "followers" of a conversation owned by another view, receiving turn-by-turn status with tiered permissions.

---

## 13. Commands & Menu Integration

### Command Palette Surface
- Open in various locations: new tab, primary editor, sidebar, new window, terminal.
- New conversation.
- Reopen closed conversation.
- Focus chat / blur chat.
- Insert `@`-mention from editor.
- Accept / reject proposed diffs.
- Plugin marketplace.
- Extension logs.
- Onboarding walkthrough.

### Context Menus
- **Editor context menu** — "Add to Thread" when text is selected.
- **Editor tab context menu** — "Add File to Thread."
- **Webview context menu** — "New Chat."

### Editor Title Bar
- Open sidebar button with icon, present in the editor title bar.
- Accept / reject diff buttons when a proposed diff is being viewed (navigation group).

### Conditional Command Visibility
- Commands can be hidden from the command palette when inappropriate via `"when"` clauses (e.g., reopen-location commands, blur/focus commands, and new-conversation shortcuts are only accessible via keyboard shortcut, not the palette).

---

## 14. Security & Content Policy

### Content Security Policy
- **Dynamic CSP generation** — CSP meta tag injected at runtime using VS Code's `cspSource`, allowing runtime-specific sources (e.g., OAuth domains) without hardcoding.
- **Restrictive defaults** — `default-src 'none'` with explicit grants for style, script, font, media, connect, and image sources.
- **Script nonce** — All inline scripts use a random nonce generated at webview creation time.
- **No external image loading** — Images come through the extension host as data URIs or webview URIs; no `img-src https:`.
- **Webview-resource loading** — All assets loaded via `asWebviewUri()`, not external URLs.

### Resource Isolation
- **`localResourceRoots`** — Webview resources restricted to the extension's webview directory.
- **Hashed filenames** — Bundled assets use content-hash filenames for cache-busting and integrity.

---

## 15. Accessibility

- **`prefers-reduced-motion` support** — Loading animations, hover transitions, and shimmer effects disabled when the user has reduced-motion enabled at the OS level.
- **High-contrast theme support** — CSS adjustments for `.hc-black` and `.hc-light` VS Code body classes.
- **Pointer-cursor control** — A `usePointerCursors` setting for users who prefer default cursors over pointer cursors on interactive elements.
- **Reduced-motion preference** — Configurable as `system` (follow OS), `on`, or `off`.
- **Font-size overrides** — Respects VS Code's accessibility font-size settings (`chat.fontSize`, `chat.editor.fontSize`).
- **System `color-scheme`** — Native form elements use the appropriate `color-scheme` CSS property.

---

## 16. Plugins & Extensibility

- **Plugin marketplace** — A marketplace surface for discovering and installing extensions to the assistant.
- **Install/uninstall/enable/disable** — Full lifecycle management for plugins from within the chat UI.
- **Marketplace management** — Add, remove, and refresh marketplace sources.
- **Plugin list** — Browse installed plugins with enabled/disabled state.
- **Custom language support** — Ships a custom grammar/language for configuration and rule files (`.rules` extension) with syntax highlighting.
- **LSP/MCP integration** — Server management with configuration visibility in the command palette.

---

## 17. Code Review

- **`/review` command** — Initiates a code review of attached files or the entire workspace.
- **Inline review** — Review feedback rendered directly in the chat flow as annotated comments.
- **Detached review** — Review feedback opened in a separate diff view. Controlled by a `reviewDelivery` setting (`inline` vs `detached`).

---

## 18. Plan Mode & Permission Control

- **Plan mode** — Before executing complex changes, the agent generates a plan preview that the user can review, modify, approve, or close.
- **Collaboration-mode toggle** — A mode that keeps the agent in planning/review state rather than auto-executing.
- **Permission modes** — A QuickPick-based mode selector with a trust gradient:
  - **Default** — Ask for confirmation before each file edit or shell command.
  - **Accept Edits** — Auto-approve file changes; ask for shell commands.
  - **Plan** — Generate plans only; no execution.
  - **Bypass** — Auto-approve all actions (for experienced users or sandboxed environments).
- **First-class mode UX** — The current mode displayed in the chat header; mode switching is a two-click operation.

---

## 19. Git & Filesystem Integration

- **Git worktree support** — Create isolated Git worktrees from the chat for sandboxed experimentation without affecting the main working tree.
- **Workspace monitoring** — Extension watches for workspace folder changes and broadcasts updated roots to all views.
- **Managed sandbox directories** — Agent operations can be scoped to sandbox directories separate from the user's working tree.

---

## 20. WebView Architecture

### Initialization
- **`<base href>` injection** — The HTML entry point has a placeholder replaced at runtime with the correct webview base URI.
- **Module preloading** — JavaScript entry points loaded via `<link rel="modulepreload">` for fast cold starts.
- **Full-state init** — On webview ready, the extension sends authentication status, model, preference mode, feature flags, onboarding state, and default working directory in a single payload.

### Communication Protocol
- **Typed postMessage bridge** — The webview and extension host communicate via a typed message protocol with distinct message types for agent interaction, file operations, session management, configuration, authentication, plugin management, and browser control.
- **Request/response with timeouts** — IPC uses request IDs and timeout handling for operations that require acknowledgment.
- **Broadcast + targeted channels** — Messages can be broadcast to all views or targeted to a specific view by ID.

### Performance
- **Bundled assets with hashes** — Content-hash filenames for deterministic caching and fast reloads.
- **Scoped CSS** — CSS Modules prevent unused style accumulation; each component ships only its own styles.
- **`retainContextWhenHidden`** — Webview DOM survives tab switches, avoiding expensive re-initialization.
