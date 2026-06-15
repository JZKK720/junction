# OpenClaw Gateway Internals

These components are specific to the OpenClaw bridge.

| Component | File | Role |
|---|---|---|
| `GatewayConnection` | `gateway/connection.ts` | WS lifecycle, request/response multiplexer, session watch filter, capability object |
| `SessionManager` | `gateway/sessionManager.ts` | Folder ↔ session binding, chat creation, history load, agent overrides |
| `CommandPalette` | `gateway/commandPalette.ts` | Slash suggestion cache — loaded from gateway on connect |
| `ModelManager` | `gateway/modelManager.ts` | Model list cache with `invalidate()` on config change |
| `ToolStatusManager` | `gateway/toolStatus.ts` | Tool enabled/disabled list from gateway |
| `ChatIndex` | `gateway/chatIndex.ts` | `bindingId → sessionKey` index persisted to global storage |
| `FolderSessions` | `gateway/folderSessions.ts` | Lists sessions owned by this binding |
| `LmTools` | `gateway/lmTools.ts` | Registers OpenClaw as a VS Code language model API provider |
| `GatewayDiscovery` | `gateway/gatewayDiscovery.ts` | Port-scans localhost for running gateway instances |
| `AgentConfig` | `gateway/agentConfig.ts` | `listAgents()`, `abortRun()`, `setSessionModel()` RPC helpers |
| `Capabilities` | `gateway/capabilities.ts` | Parses gateway capability flags from handshake |
| `LmProvider` | `gateway/lmProvider.ts` | VS Code LM API provider adapter |

## Capability Flags

Gateway handshake returns capability flags used to gate features:
- `canListSessions()` — sessions list
- `canListModels()` — model picker
- `canListAgents()` — agent picker
- `canSteer()` — steering/injection
- `hasMethod(name)` — per-RPC gate

## Auth Scopes

- `operator.admin` scope: enables admin inject (`canAdminInject()`)
- Device token stored in `vscode.SecretStorage`
