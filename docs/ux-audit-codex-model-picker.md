# UX Audit: Codex (OpenAI ChatGPT VSCode Extension) Model Picker

**Extension:** `openai.chatgpt` v26.5527.31454  
**Date of audit:** 2026-05-31  
**Source:** Reverse-engineered from compiled webview assets + extension.js

---

## 1. Model Picker UI

### Rendering Approach

The model picker is **NOT a native VS Code QuickPick**. It is a **custom webview dialog** built on a **slash command palette** (cmdk-style, referred to as `Ko` / `CommandMenu` internally).

### How It Renders

The model selection is a **slash command** registered with `id: "model"`. It is triggered by:
- Typing `/model` in the composer
- Opening the slash command menu (Ctrl+K / Cmd+K, Ctrl+Shift+P) and searching "Model"
- The dedicated keyboard shortcut `Ctrl+Shift+M` (`composer.openModelPicker`)

When activated, the slash command dialog appears as a floating panel above the composer input, containing:
- A search input
- A scrollable list of command items

### Visual Hierarchy

```
┌─────────────────────────────────────────┐
│ Search...                               │  ← Ko.Input
├─────────────────────────────────────────┤
│ Models:                                 │  ← Optional group header
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 🧠  gpt-5.5                ✓  ⚡  │ │  ← Ko.Item (xc component)
│ │     OpenAI's most capable model     │ │  ← Description line
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ 🧠  gpt-5.4                        │ │
│ │     Faster, lighter model          │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ 🧠  gpt-5.3-codex                  │ │
│ │     Code-optimized model           │ │
│ └─────────────────────────────────────┘ │
│ ...                                     │
├─────────────────────────────────────────┤
│ No commands                             │  ← Ko.Empty (when no matches)
└─────────────────────────────────────────┘
```

### Command Item Structure (Per Model)

Each model entry uses the `xc` (CommandItem) component with these props:

| Prop | Value | Details |
|------|-------|---------|
| `value` | Display name (e.g. "gpt-5.5") | Formatted via `kh()` which calls `lr()` lookup for `displayName` |
| `title` | Same display name | Rendered bold, with fuzzy-match highlighting |
| `description` | Model description string | e.g. "OpenAI's most capable model" |
| `RightIcon` | Check icon (`fa`) | Only if this is the currently active model |
| `rightAccessory` | Service tier icon | Speed badge (lightning bolt) if model matches current service tier |
| `onSelect` | Callback | Sets model + reasoning effort |

### Organization

- **Flat list** — models are NOT grouped by tier, capability, or family
- Order is as returned by the API (`list-models-for-host`)
- No nested submenus for model selection
- Reasoning effort is a **separate** slash command (`id: "reasoning"`) — not nested under the model picker

### Footer Display (Current Model Indicator)

In the composer footer, the currently selected model is displayed in two parts:

1. **Model chip** (`vm` component):
   - Rounded pill (`Ka` badge component)
   - CSS: `rounded-full px-2 py-0 text-sm`
   - Max width 10rem with truncation
   - Tooltip on overflow

2. **Intelligence/Reasoning control** (`Ap` component):
   - Displays current reasoning effort level
   - Clickable to open reasoning selection
   - Can be hidden when label mode is compact

Footer control layout (function `_m`):
```
[Model Name Chip] [Context Usage] [Intelligence/Reasoning] [Footer Controls...]
```

Width-aware: items can be hidden based on available width using `tm()` adaptive layout.

---

## 2. Model Data

### Data Sources

Models are sourced from **three integration points**, merged in `use-model-settings-7FKQ1uyP.js`:

#### 2a. Primary: Codex App Server API (function `S` in `model-queries`)
```javascript
// Query: list-models-for-host
queryKey: ["models", "list", hostId, authMethod, limit]
queryFn: () => list-models-for-host({
    hostId,
    includeHidden: true,
    cursor: null,
    limit: 100  // default limit
})
```
- Endpoint: `app-server-manager-signals.js` → `Qs("list-models-for-host", ...)`
- Each model entry returned has: model ID, description, supported reasoning efforts, default reasoning effort, display name, hidden flag, isDefault flag

#### 2b. Copilot Auth Fallback (function `W`)
```javascript
// For copilot auth method only
useGlobalState("copilot-default-model")
// Returns {model: "gpt-5.5", reasoningEffort: "medium", ...}
```

#### 2c. User Config (config.toml) — function `P`
```javascript
// Query: user-saved-config
queryKey: ["user-saved-config", hostId, cwd]
queryFn: read-config-for-host({hostId, includeLayers: false, cwd})
```

### Default Model Resolution

In `B()` function (model settings hook):
1. If `userSavedModelString` is set and model exists in list → use it
2. Else use `defaultModel` from list
3. Else fall back to hardcoded `"gpt-5.5"`

### Model Entry Metadata

Each model entry from the API carries:

```typescript
{
  model: string,                    // e.g. "gpt-5.5"
  displayName?: string,             // Human-readable name
  description?: string,             // e.g. "OpenAI's most capable model"
  supportedReasoningEfforts: [{     // Array of supported effort levels
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh",
    description: string
  }],
  defaultReasoningEffort: string,   // Default effort for this model
  isDefault: boolean,               // Whether this is the system default
  hidden: boolean,                  // Hidden models excluded unless useHiddenModels is set
  inputModalities?: string[],       // e.g. ["text", "image"]
}
```

### Reasoning Effort Levels

```
none     → reasoning.none.label     = "None"
minimal  → reasoning.minimal.label  = "Minimal"
low      → reasoning.low.label      = "Low"
medium   → reasoning.medium.label   = "Medium"
high     → reasoning.high.label     = "High"
xhigh    → reasoning.xhigh.label    = "Extra High"
```

### Service Tier / Speed

Separate from model selection. Available tiers via `Lr` hook (`serviceTierSettings`):
- Each option has: `value`, `label`, `description`, `iconKind`
- Set via `setServiceTier(option, "slash_command")`
- Effective tier stored in `default-service-tier` persisted atom

---

## 3. Selection Flow

### What Happens on Model Selection

When a user selects a model from the slash command dialog:

1. **Analytics event fired:**
   ```
   eventName: "codex_composer_model_changed"
   metadata: { model: "gpt-5.5" }
   ```

2. **For new conversations:**
   ```javascript
   setModelAndReasoningEffort(modelId, reasoningEffort)
   // → Calls set-model-and-reasoning-for-next-turn API
   // → Or set-default-model-config-for-host if no conversation active
   ```

   If Copilot auth: saves to `copilot-default-model` global state

3. **For existing conversations:**
   - Checks `Dh` atom (conversation message count > 0)
   - If conversation has messages, shows warning toast:
     > "Changing models mid-conversation will degrade performance."
   - Sets model + reasoning for next turn via `set-model-and-reasoning-for-next-turn`

4. **Reasoning effort resolution:**
   - If current reasoning effort is supported by new model → keep it
   - Otherwise → use new model's `defaultReasoningEffort`
   - If none set → use first supported effort

### Global vs Per-Conversation

- **New chats:** Model selected applies to the *next* conversation that starts
- **Existing chats:** Model change applies to the *next turn* within that conversation
- Config.toml override (`model` and `model_reasoning_effort`) persists across sessions

### Feedback After Selection

- Slash command dialog closes
- Footer model chip updates immediately with new model name
- Intelligence/reasoning control updates with new reasoning effort
- If mid-conversation: informational toast shown
- If Copilot auth: value persisted via global state

---

## 4. Menu/Submenu Pattern

### Navigation Structure

```
Composer Footer
  ├── [Model Chip]        ← Click → opens slash command with /model pre-filled
  ├── [Context Usage]     ← Token/context window display
  ├── [Intelligence]      ← Reasoning effort selector (separate slash command)
  ├── [IDE Context]       ← Toggle IDE context
  ├── [Plan Mode]         ← Toggle plan/default mode
  └── [Goal]              ← Clear/activate goal mode
```

### Slash Command Dialog (the "menu")

The slash command dialog (`Fs` component / `j_` function) is a single-level searchable command palette:

- **Search input** filters commands by fuzzy matching title
- **Commands with `Content`** → clicking opens a sub-view (replaces list with custom content)
- **Commands without `Content`** → direct action on select
- **Group headers** rendered based on `group` property (e.g., "Skills" group)
- **Back navigation:** closing the dialog (Escape, clicking outside) returns to composer

### Model Picker Sub-View

When the Model slash command is selected, the `Content` function renders the model list:
- The model list replaces the command list entirely
- The search input remains, filtering models by name
- Each model is a flat `xc` item
- No back button — close returns to composer

### Reasoning Effort Sub-View

Separate slash command (`id: "reasoning"`), rendered as a flat list of effort levels:
- Each level gets an icon indicating the effort level
- Currently selected level gets a checkmark
- Selecting one calls `setModelAndReasoningEffort(model, effort)`

### Service Tier Sub-View

Slash commands generated per available tier option with id `service-tier:{value}`:
- Toggle behavior: selecting the active tier disables it (sets to null)
- Each option has a custom icon
- Selecting a different tier enables it

### Separators / Grouping

- **Model list:** No internal grouping — flat list
- **Slash command menu:** Groups via `group` property on command items
- **Footer:** `FooterDivider` component between model chip and other controls

### Keyboard Shortcuts

| Shortcut | Command | Scope |
|----------|---------|-------|
| `Ctrl+Shift+M` | `composer.openModelPicker` | App-wide |
| (unbound) | `composer.cycleReasoningEffort` | App |
| (unbound) | `composer.increaseReasoningEffort` | App |
| (unbound) | `composer.decreaseReasoningEffort` | App |
| (unbound) | `composer.toggleFastMode` | App |
| `Ctrl+K` / `Cmd+K` | Open slash command menu | Electron |
| `Ctrl+Shift+P` | Open slash command menu (alt) | Electron |

Note: Only `Ctrl+Shift+M` has a default binding. The cycling shortcuts exist as command registrations but have no default keybindings.

---

## 5. Fallback / Error States

### Model List Load Failure

The `_r` query for `list-models-for-host` has three states tracked via `vr(status)`:

```
"loading"  → isAuthLoading || status === "pending"
"error"    → status === "error"
"success"  → status === "success"
```

When status is `"error"`:
- The Model slash command is **disabled** (`enabled: false`)
- The model count check: `(c?.models.length ?? 0) > 0` fails
- No model picker content is available

### Copilot Default Model Loading

When `isLoading` is true for `copilot-default-model`:
- Returns `{model: "gpt-5.5", reasoningEffort: "medium", isLoading: true}`
- The footer model chip shows the hardcoded default model
- Actual model selection UI is available once loading completes

### No Auth

When the host requires auth (`requiresAuth: true`) but auth is not loaded:
- The `enabled` check: `s && d && l !== "error" && (c?.models.length ?? 0) > 0` → false
- Model slash command is **not registered** (disabled)
- The footer shows no model chip for cloud tasks

### Auth Method = Copilot

When authenticated via Copilot:
- `defaultModel` comes from `copilot-default-model` global state instead of API
- `isLoading: true` until the global state is fetched
- Fallback model hardcoded: `"gpt-5.5"`

### Config Divergence

If the config.toml settings (`direct` query) and the app-server settings (`maitai` query) diverge (different models or reasoning effort):
- A warning is logged via `app-server-manager-signals.js` → `a.warning("model_settings.config_query_diverged", ...)`
- The config.toml value takes precedence
- Both values continue to be tracked for debugging

### Cyber Safety Banner

For conversations flagged for cybersecurity risk:
- A banner appears above the composer (`Mg`/`Ng` components)
- For `repeated_blocks` variant: shows a "Continue with 5.4" button
- Clicking switches model to `gpt-5.4` (hardcoded constant `C`)
- The model change uses `setModelAndReasoningEffortForNextTurn`

### Empty Model List

If the API returns zero models:
- The Model slash command description shows the hardcoded default `"gpt-5.5"`
- No model picker dialog is available
- The footer model chip may still show the default model

### No Model Selected

When no model is explicitly selected (fresh install, no config):
- `B()` resolves to: `gpt-5.5` (hardcoded constant `f`)
- Reasoning effort resolves to: `defaultReasoningEffort` || `"medium"`
- Footer shows the resolved model name

---

## Key Observations for Reimplementation

1. **Model + Reasoning are coupled but separate** — Selecting a model auto-selects a compatible reasoning effort, but the user can change reasoning independently via a separate slash command
2. **No grouping/tiering** — Models are flat, no "Reasoning models" vs "Fast models" submenus
3. **Service tier (speed) is a third axis** — independent of both model and reasoning effort, with its own toggle UI
4. **The slash command palette is the primary interaction pattern** — everything (model, reasoning, speed, personality, plan mode) goes through the same cmdk-style dialog
5. **Config override system is complex** — model can come from API, Copilot global state, or config.toml, with a divergence detection system for debugging
6. **The footer is width-adaptive** — model chip, context usage, and intelligence controls auto-hide based on available pixel width
7. **No native QuickPick** — the extension bypasses VS Code's built-in picker completely for its custom webview UI
