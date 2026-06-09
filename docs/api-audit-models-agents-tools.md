# OpenClaw API Audit: Models, Agents, Tools

> Read-only audit for VSCode extension building a model picker, thinking selector, and agent selector.
> Source: `~/sauce/openclaw-src/` — commit snapshot 2026-05-31.

---

## 1. Model Catalog (`models.list`)

### Method Signature

```
models.list(params?: { view?: "default" | "configured" | "all" })
```

**Scope:** `operator.read`

### `view` Parameter

| Value | Behavior |
|-------|----------|
| `"default"` (omitted) | Visible models: configured models + auth-backed catalog entries, deduplicated, sorted by provider then id |
| `"configured"` | Same as default for the gateway method (falls through to default path) |
| `"all"` | Full raw catalog including models without auth credentials |

### Response Shape

```typescript
{
  models: Array<{
    id: string;               // e.g. "gpt-5.5"
    name: string;             // e.g. "GPT-5.5"
    provider: string;         // e.g. "openai"
    alias?: string;           // Optional alias
    contextWindow?: number;   // Context window size
    reasoning?: boolean;      // Whether model supports reasoning/thinking
  }>
}
```

The schema (`ModelChoiceSchema`) exposes only these 6 fields. The internal `ModelCatalogEntry` type has more fields (`contextTokens`, `input[]`, `compat`, `mediaInput`) but the gateway response schema filters to only the public fields above.

### How the Catalog is Built

1. **Static built-in catalog** (`openclaw-models.json`) — ships with all known provider models
2. **Configured models** (`openclaw.json` `models.providers` section) — user overrides/aliases
3. **PI (Provider Interface) discovery** — runtime discovery for CLI providers (e.g., claude-cli)
4. **Plugin-augmented** — provider plugins can register model metadata

The visible list filters to only models where the provider has auth configured.

### Default Provider & Model

```typescript
// From src/agents/defaults.ts
DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-5.5"
```

---

## 2. Model Configuration in `openclaw.json`

### Per-Provider Models

```json
{
  "models": {
    "providers": {
      "openai": {
        "models": ["gpt-5.5", "gpt-5.5-mini", "o4-pro"]
      }
    }
  }
}
```

### Model Aliases

Configured via config's model visibility entries. Aliases are resolved through the provider model catalog normalization pipeline. The `alias` field on `ModelCatalogEntry` represents a user-facing alias name.

### Agent Defaults: `agents.defaults.models`

Each agent can have:
- `model` — primary model ref (e.g. `"openai/gpt-5.5"` or just `"gpt-5.5"`)
- `model.fallbacks` — array of fallback model refs

Example:
```json
{
  "agents": {
    "defaults": {
      "model": "openai/gpt-5.5-mini"
    },
    "list": [
      {
        "id": "ops",
        "model": "anthropic/claude-sonnet-4-5"
      }
    ]
  }
}
```

Per-agent models override the global `agents.defaults.model`.

### Model Ref Format

Models are referenced as:
- `"provider/model"` — explicit provider+model
- `"model"` — model only, provider inferred from config
- CLI providers use `"provider/alias"` where alias is the CLI model name

---

## 3. Agent Management

### `agents.list`

**Scope:** `operator.read`
**Params:** `{}` (empty object)

**Response:**
```typescript
{
  defaultId: string;       // e.g. "main"
  mainKey: string;         // e.g. "main"
  scope: "per-sender" | "global";
  agents: Array<{
    id: string;            // Agent id e.g. "main", "ops"
    name?: string;         // Display name
    identity?: {
      name?: string;
      theme?: string;
      emoji?: string;
      avatar?: string;
      avatarUrl?: string;  // Resolved data: URL or null
    };
    workspace?: string;    // Workspace directory path
    model?: {
      primary?: string;    // Primary model ref
      fallbacks?: string[];// Fallback model refs
    };
    agentRuntime?: {
      id: string;
      fallback?: "pi" | "none";
      source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit";
    };
  }>
}
```

The default agent is always first in the list. Additional agents sorted alphabetically.

### `agents.create`

**Scope:** `operator.admin`
**Params:**
```typescript
{
  name: string;
  workspace: string;
  model?: string;
  emoji?: string;
  avatar?: string;
}
```
**Response:** `{ ok: true, agentId, name, workspace, model? }`

### `agents.update`

**Scope:** `operator.admin`
**Params:**
```typescript
{
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string;
  emoji?: string;
  avatar?: string;
}
```

### `agents.delete`

**Scope:** `operator.admin`
**Params:** `{ agentId: string, deleteFiles?: boolean }` (default: `deleteFiles: true`)
**Response:** `{ ok: true, agentId, removedBindings: number }`

### `agents.files.list`

**Scope:** `operator.read`
**Params:** `{ agentId: string }`
**Response:** `{ agentId, workspace, files: Array<{ name, path, missing, size?, updatedAtMs? }> }`

### `agents.files.get` / `agents.files.set`

**Scope:** `operator.read` / `operator.admin`
Read/write individual agent workspace files (IDENTITY.md, AGENTS.md, SOUL.md, etc.)

### `agent.identity.get`

**Scope:** `operator.read`
**Params:**
```typescript
{
  agentId?: string;
  sessionKey?: string;
}
```
**Response:**
```typescript
{
  agentId: string;
  name?: string;
  avatar?: string;
  avatarSource?: string;
  avatarStatus?: "none" | "local" | "remote" | "data";
  avatarReason?: string;
  emoji?: string;
}
```

### Default Agent Resolution

The default agent ID is resolved from config — typically `"main"`. Session-scoped methods that omit `agentId` use the session's owning agent. System-wide methods use the default agent.

### Session Creation with AgentId

`sessions.create` accepts:
```typescript
{
  key?: string;           // Optional session key
  agentId?: string;       // Target agent
  label?: string;
  model?: string;         // Model ref
  parentSessionKey?: string;
  emitCommandHooks?: boolean;
  task?: string;
  message?: string;
}
```

---

## 4. Session Model Override (`sessions.patch`)

### Method Signature

```
sessions.patch(params: SessionsPatchParams)
```

**Scope:** `operator.admin`

### Relevant Patch Fields

```typescript
{
  key: string;                                    // Required. Session key.

  // Model override
  model: string | null;                           // Model ref (e.g. "openai/gpt-5.5" or "gpt-5.5-mini").
                                                  // Null = reset to default.

  // Thinking control
  thinkingLevel: string | null;                   // See valid values below. Null = clear override.

  // Display/info control
  verboseLevel: string | null;                    // "off" | "on" | "full"
  traceLevel: string | null;                      // "off" | "on" | "raw"
  reasoningLevel: string | null;                  // "off" | "on" | "stream"
  responseUsage: "off" | "tokens" | "full" | "on" | null;  // "on" is legacy alias for "tokens"
  fastMode: boolean | null;

  // Execution control
  elevatedLevel: string | null;                   // "off" | "on" | "ask" | "full"
  execHost: string | null;                        // "auto" | "sandbox" | "gateway" | "node"
  execSecurity: string | null;                    // "deny" | "allowlist" | "full"
  execAsk: string | null;                         // "off" | "on-miss" | "always"
  execNode: string | null;

  // Subagent control
  spawnedBy: string | null;
  spawnedWorkspaceDir: string | null;
  spawnDepth: number | null;
  subagentRole: "orchestrator" | "leaf" | null;
  subagentControlScope: "children" | "none" | null;
  inheritedToolAllow: string[] | null;
  inheritedToolDeny: string[] | null;

  // Send policy
  sendPolicy: "allow" | "deny" | null;
  groupActivation: "mention" | "always" | null;

  // Label
  label: string | null;
}
```

**Response:**
```typescript
{
  ok: true;
  key: string;
  entry: SessionEntry;  // Full session store entry after patch
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
  };
}
```

### `model` Field Behavior

- Accepts a model ref string: `"provider/model"` or just `"model"` (provider inferred)
- Setting `null` resets to the agent/default model
- Gateway validates the model exists in the catalog
- On success, `providerOverride` and `modelOverride` are written to the session store

### `thinkingLevel` Valid Values

The base thinking levels are:

| Level | Description |
|-------|-------------|
| `"off"` | No thinking/reasoning |
| `"minimal"` | Minimal thinking |
| `"low"` | Low thinking (also accepts `"on"`, `"enable"`, `"enabled"` as aliases) |
| `"medium"` | Medium thinking |
| `"high"` | High thinking |
| `"xhigh"` | Extra-high thinking (only for models that advertise xhigh reasoning) |
| `"adaptive"` | Adaptive/auto (also accepts `"auto"`) |
| `"max"` | Maximum available thinking |

**Not all levels are available for all models.** The gateway validates the requested level against the model's supported thinking profile. Setting `null` clears the override.

Session rows also expose:
- `thinkingLevel` — current level (string or undefined)
- `thinkingLevels` — array of `{ id: string, label: string }` (all levels available for the session's model)
- `thinkingOptions` — array of label strings (UI-friendly)
- `thinkingDefault` — the default level for the session's model/provider/agent

### Other Per-Session Controls on Session Rows

From `GatewaySessionRow`:
- `fastMode?: boolean`
- `verboseLevel?: string`
- `traceLevel?: string`
- `reasoningLevel?: string`
- `elevatedLevel?: string`
- `sendPolicy?: "allow" | "deny"`
- `responseUsage?: "on" | "off" | "tokens" | "full"`
- `modelProvider?: string` — resolved display provider
- `model?: string` — resolved display model

---

## 5. Per-Request Model Override (`agent` method)

### Method Signature

```
agent(params: AgentParams)
```

**Scope:** `operator.write`

### Relevant Params

```typescript
{
  message: string;                    // Required. The user message.

  // Model selection
  provider?: string;                  // Provider override for this request
  model?: string;                     // Model override for this request

  // Thinking
  thinking?: string;                  // Thinking level for this request

  // Session targeting
  agentId?: string;                   // Target agent
  sessionKey?: string;                // Target session key
  sessionId?: string;                 // Target session by transcript ID

  // Delivery
  deliver?: boolean;                  // Whether to deliver the response
  channel?: string;                   // Delivery channel
  replyChannel?: string;              // Reply channel
  accountId?: string;                 // Channel account
  to?: string;                        // Recipient
  replyTo?: string;                   // Reply target message
  threadId?: string;                  // Thread ID
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;

  // Bootstrap control
  bootstrapContextMode?: "full" | "lightweight";  // Context injection mode
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";

  // Prompt control
  promptMode?: "full" | "minimal" | "none";
  extraSystemPrompt?: string;

  // Attachments
  attachments?: unknown[];

  // Misc
  timeout?: number;                   // Timeout in ms
  lane?: string;
  label?: string;
  idempotencyKey: string;             // Required
  sessionEffects?: "visible" | "internal";
  disableMessageTool?: boolean;
  voiceWakeTrigger?: string;
}
```

### Key Observations

- `provider` and `model` are **separate** fields (not a combined ref string)
- `thinking` is a separate field
- These are **per-request overrides** — they don't persist to the session store
- `bootstrapContextMode: "lightweight"` reduces context injection size — useful for tool-calling without full agent persona

---

## 6. Commands & Tools

### `commands.list`

**Scope:** `operator.read`
**Params:**
```typescript
{
  agentId?: string;        // Default: default agent
  provider?: string;       // Channel provider for native name resolution
  scope?: "text" | "native" | "both";  // Default: "both"
  includeArgs?: boolean;   // Default: true
}
```

**Response:**
```typescript
{
  commands: Array<{
    name: string;                    // Command name (for text: includes leading /)
    nativeName?: string;             // Native/UI name if different
    textAliases?: string[];          // Text aliases (with leading /)
    description: string;             // Max 2000 chars
    category?: "session" | "options" | "status" | "management" | "media" | "tools" | "docks";
    source: "native" | "skill" | "plugin";
    scope: "text" | "native" | "both";
    acceptsArgs: boolean;
    args?: Array<{
      name: string;                  // Max 200 chars
      description: string;           // Max 500 chars
      type: "string" | "number" | "boolean";
      required?: boolean;
      choices?: Array<{ value: string; label: string }>;  // Max 50
      dynamic?: boolean;             // Choices resolved at runtime
    }>;                              // Max 20 args
  }>;                                // Max 500 commands total
}
```

### `tools.catalog`

**Scope:** `operator.read`
**Params:**
```typescript
{
  agentId?: string;        // Default: default agent
  includePlugins?: boolean; // Default: true
}
```

**Response:**
```typescript
{
  agentId: string;
  profiles: Array<{
    id: "minimal" | "coding" | "messaging" | "full";
    label: string;
  }>;
  groups: Array<{
    id: string;            // "core" section id or "plugin:<pluginId>"
    label: string;
    source: "core" | "plugin";
    pluginId?: string;     // Only for plugin groups
    tools: Array<{
      id: string;          // Tool identifier
      label: string;       // Display name
      description: string; // Summarized description
      source: "core" | "plugin";
      pluginId?: string;
      optional?: boolean;
      risk?: "low" | "medium" | "high";
      tags?: string[];
      defaultProfiles: Array<"minimal" | "coding" | "messaging" | "full">;
    }>;
  }>;
}
```

This is the **complete** tool catalog — all known tools across all profiles.

### `tools.effective`

**Scope:** `operator.read` (startup method)
**Params:**
```typescript
{
  agentId?: string;        // Must match the session's agent
  sessionKey: string;      // Required. Session context for resolution.
}
```

**Response:**
```typescript
{
  agentId: string;
  profile: string;         // Active tool profile name
  groups: Array<{
    id: "core" | "plugin" | "channel";
    label: string;
    source: "core" | "plugin" | "channel";
    tools: Array<{
      id: string;
      label: string;
      description: string;
      rawDescription: string;  // Unsummarized description
      source: "core" | "plugin" | "channel";
      pluginId?: string;
      channelId?: string;
      risk?: "low" | "medium" | "high";
      tags?: string[];
    }>;
  }>;
  notices?: Array<{
    id: string;
    severity: "info" | "warning";
    message: string;
  }>;
}
```

This is the **active** tool set for a specific session, resolved against:
- Agent config
- Session's model (for vision capability checks)
- Channel/provider context
- Active plugin registry

**Caching:** Results cached for 10s (fresh) / 120s (stale with background refresh). Cache key includes config version, plugin registry version, channel registry version, session key, agent, model, provider, channel, thread, group, and reply mode.

---

## 7. Session Capabilities

### `sessions.usage`

**Scope:** `operator.read` (not advertised — `advertise: false`)
**Params:**
```typescript
{
  key?: string;              // Specific session key (for single-session analysis)
  agentId?: string;          // Agent scope for list queries
  startDate?: string;        // YYYY-MM-DD
  endDate?: string;          // YYYY-MM-DD
  mode?: "utc" | "gateway" | "specific";
  range?: "7d" | "30d" | "90d" | "1y" | "all";
  groupBy?: "instance" | "family";
  includeHistorical?: boolean;  // Alias for groupBy: "family"
  utcOffset?: string;        // e.g. "UTC-4", "UTC+5:30" (for mode: "specific")
  limit?: number;            // Default: 50
  includeContextWeight?: boolean;
}
```

**Response:**
```typescript
{
  updatedAt: number;
  startDate: string;         // YYYY-MM-DD
  endDate: string;           // YYYY-MM-DD
  sessions: Array<{
    key: string;
    label?: string;
    sessionId: string;
    scope: "instance" | "family";
    sessionFamilyKey?: string;
    currentSessionId?: string;
    includedSessionIds?: string[];
    historicalInstanceCount?: number;
    updatedAt: number;
    agentId: string;
    channel?: string;
    chatType?: string;
    origin?: SessionEntry["origin"];
    modelOverride?: string;
    providerOverride?: string;
    modelProvider?: string;
    model?: string;
    usage: SessionCostSummary;  // Token counts, cost breakdown
    contextWeight?: SystemPromptReport | null;
  }>;
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheWriteCost: number;
    missingCostEntries: number;
  };
  aggregates: {
    messages: SessionMessageCounts;
    tools: {
      totalCalls: number;
      uniqueTools: number;
      tools: Array<{ name: string; count: number }>;
    };
    byModel: Array<SessionModelUsage>;
    byProvider: Array<SessionModelUsage>;
    byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
    // + additional aggregate fields (daily, latency, etc.)
  };
  cacheStatus?: UsageCacheStatus;
}
```

### `chat.inject`

**Scope:** `operator.admin` (not advertised — `advertise: false`)
**Params:**
```typescript
{
  sessionKey: string;        // Required
  message: string;           // Required
  label?: string;            // Max 100 chars
}
```

Injects a message into a session's chat history without triggering an agent run. Used for setting up context or restoring state.

---

## 8. Summary: Building the UI

### Model Picker

1. **Call `models.list`** for available models → `{ models: Array<{ id, name, provider, alias?, contextWindow?, reasoning? }> }`
2. Group by `provider` field for a provider → model hierarchy
3. For per-session model display, use `sessions.list` → each row has `modelProvider` and `model`
4. **Setting the model per-session:** `sessions.patch({ key, model: "provider/model" })` → `model` field accepts full ref or model-only (provider inferred)
5. **Setting model per-request:** `agent({ provider, model })` — two separate fields

### Thinking Level Selector

1. **Available levels per session:** From `sessions.list` response, each session row has `thinkingLevels: Array<{ id, label }>` — this is the model-aware list
2. **Current level:** `thinkingLevel` on the session row
3. **Default level:** `thinkingDefault` on the session row
4. **Setting the level:** `sessions.patch({ key, thinkingLevel: "high" })`
5. **Setting per-request:** `agent({ thinking: "high" })`
6. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`
7. Not all models support all levels. The gateway validates and rejects unsupported levels.

### Agent Selector

1. **Call `agents.list`** for all agents → `{ defaultId, mainKey, scope, agents: [...] }`
2. Each agent has `id`, `name`, `identity.{ name, emoji, avatar, avatarUrl, theme }`, `workspace`, `model.primary`, `agentRuntime`
3. **Default agent** is `response.defaultId` (typically `"main"`) — always first in the list
4. **Current session's agent:** From `sessions.list` — the session key is `agent:<agentId>:...`
5. **Switching agents:** Create a new session with `sessions.create({ agentId })` or target a different agent in `agent()` calls
6. **Identity info:** `agent.identity.get({ agentId })` returns `{ name, avatar, avatarSource, avatarStatus, emoji }`

### Tool Visibility

1. **All tools:** `tools.catalog` → complete catalog organized by profile and group
2. **Active tools for session:** `tools.effective({ sessionKey })` → what the agent actually has access to
3. **Profile definitions:** `tools.catalog` returns `profiles: [{ id: "minimal"|"coding"|"messaging"|"full", label }]`

### Session Defaults

`sessions.list` response includes a `defaults` object:
```typescript
{
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  thinkingLevels?: Array<{ id, label }>;
  thinkingOptions?: string[];
  thinkingDefault?: string;
}
```
Use this to populate default values for the picker when creating new sessions or showing baseline settings.
