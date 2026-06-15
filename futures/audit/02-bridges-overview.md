# Bridge Registry & Capability Matrix

Five bridges registered per window. Active bridge persisted via `junction.activeBridge`. Switching disconnects the previous bridge and reconnects the new one. All bridges emit `connected`, `disconnected`, `pairingRequired` events.

## Capability Matrix

| Bridge | sessions | models | agents | steering | usage | tools |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| OpenClaw | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Hermes | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ |
| Souveraine | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| MiMoCode | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Goose | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |

## Environment Picker Menu

The environment picker shows a hierarchical `ChoiceMenuItem` tree:
- One top-level entry per bridge (with `checked` flag on active)
- Children: bridge-specific runtimes / agents / setup actions
- Selecting a bridge top-level entry switches the active bridge
- Selecting a child routes to `bridge.selectEnvironmentChoice()`
