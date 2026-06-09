# Deferred Features

Features we want but are not building in the initial release.

---

## File Context

- **"Attach file to chat window"** — right-click entry in the VS Code file explorer sidebar. Alternative to @-mentions for mouse-driven file attachment.

- **TODO/FIXME CodeLens** — when enabled, scans for `TODO`/`FIXME`/`HACK` comments and adds an "Implement with Assistant" link above each. Click sends file, line, and comment text to the agent. Toggle via `commentCodeLensEnabled` setting (default: off).

- **Agent picker** — `agents.list` API returns `{ defaultId, agents: [{ id, name, identity, workspace, model }] }`. Build a QuickPick to let the user select which agent handles the conversation. Deferred for now — sessions default to `main` agent.

- **Session forking** — Branch a conversation at a specific message to explore alternative paths. OpenClaw doesn't expose a general fork RPC (exists only for internal subagent `sessions_spawn`). Would require building a new gateway method or doing transcript surgery. Deferred.
