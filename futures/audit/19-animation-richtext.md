# Animation & Rich Text

## Extra Rich Text

- Toggle: `junction.extraRichText` (default `true`)
- Pretext canvas-based text layout with animated effects
- Applied to assistant message text (not tool rows)

## Animation Modes

`matrix` · `zalgo` · `fire` · `bounce` · `spiral` · `galaxy` · `leak`

Separate mode for the thinking/working bobber ("loader"): same options plus `default` (matches chat mode).

## Per-Mode Sliders

| Slider | Key | Range | Default |
|---|---|---|---|
| Speed | `speed` | slider | 1.0 |
| Length | `length` | slider | 2.0 |
| BG Alpha | `bgAlpha` | slider | 0.0 |
| Cooling | `cooling` | slider | 0.65 |
| Spread | `spread` | slider | 0.3 |
| Text Fade | `textFade` | slider | 0.5 |
| Curtain Fade | `curtainFade` | slider | 0.3 |

Loader has prefixed keys (e.g. `loaderSpeed`, `loaderLength`, etc.).

## Background Color

- Custom background color picker
- Transparency slider (alpha)
- Applied via CSS variable

## Settings Panel

- Live preview updates as settings change
- `saveAnimSettings()` persists to webview state
- `settingsSyncFunctions` array — each section registers a sync callback called when panel reopens
