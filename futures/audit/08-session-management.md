# Session Management

| Feature | Detail |
|---|---|
| Create new chat | All bridges; folder-scoped for OpenClaw (binds to workspace folder URI) |
| List sessions | Folder scope or "all" (global) |
| Rename sessions | Persisted to server where supported; client-side for Hermes/Souveraine/MiMoCode/Goose |
| Archive sessions | Client-side soft archive (key added to `archivedKeys` Set); excluded from list unless "show archived" toggled |
| Resume from session list | Restores transcript from in-memory cache or re-fetches from bridge |
| Session list grouping | OpenClaw: by folder binding (current folder first) · Others: flat `Recent` group |
| Scope toggle | Folder / All (UI label updated; OpenClaw queries both scopes on gateway) |
| Cross-session transcript cache | `sessionTranscripts` Map; persisted and restored on switch without re-fetch |
| Active run scoped per session | `activeRunIdsBySession` Map prevents cross-chat run bleed |
| Session watching | OpenClaw only: transport-level filter so gateway drops events for off-screen sessions |
| Auto-title on first send | First line of user message (truncated to 48 chars) used as session title |
