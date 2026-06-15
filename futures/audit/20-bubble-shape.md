# User Bubble Shape

User message bubbles have configurable shape.

## Roundness

- Slider: 0 → 32 px (maps to `--junction-bubble-radius` CSS var)
- 0 = hard corners · 32 = fully circular
- Also exposed as `junction.bubble.radius` VS Code setting (range 0–999)

## Tip Position

Three-button selector:

| Value | Label |
|---|---|
| `none` | No pointed tip |
| `bottom-right` | Tail at bottom-right |
| `top-right` | Tail at top-right |

Also exposed as `junction.bubble.tip` VS Code setting.

## Persistence

- Saved to webview state via `saveBubbleSettings()`
- `settingsSyncFunctions` callback reloads slider value from CSS var on panel reopen
