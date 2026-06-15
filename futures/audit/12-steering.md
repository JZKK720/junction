# Steering

Steering injects a message into a running agent turn without queuing as a follow-up.

## Per-Bridge Implementation

| Bridge | Method |
|---|---|
| OpenClaw | `sessions.steer` RPC → fallback `chat.inject` |
| Hermes | `prompt.submit { session_id, text: "/steer <message>" }` |
| Souveraine | `POST /v1/conversations/{id}/interject { text }` (server-side WIP) |
| MiMoCode | Not supported (`canSteer()` returns false) |
| Goose | Not supported |

## Keybinding

- `junction.steerKeybinding` setting (string, default empty = unbound)
- Sends current composer text as a steered message while run is active

## Admin Inject

OpenClaw only: `canAdminInject()` returns true when gateway auth scope includes `operator.admin`. Used to send file context as an invisible injection (not shown in UI) rather than prepending to user message.
