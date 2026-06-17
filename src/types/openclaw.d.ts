// Gateway Protocol Types
export interface GatewayMessage {
    method: string;
    params: any;
    id?: string | number;
}

export interface GatewayResponse {
    id: string | number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export interface ToolRequest {
    tool: string;
    params: any;
}

export interface ToolResult {
    success: boolean;
    result?: any;
    error?: string;
}

export interface FileEdit {
    startLine: number;
    endLine: number;
    newText: string;
}

export interface WorkspaceContext {
    workspace?: {
        name: string;
        path: string;
        type: string;
    };
    activeFile?: {
        path: string;
        language: string;
        lineCount: number;
        selection?: {
            start: number;
            end: number;
            text: string;
        };
    };
}

// ────────────────────────────────────────
// Model Catalog Types (models.list response)
// ────────────────────────────────────────

export interface ModelEntry {
    /** Model identifier (provider-specific model id) */
    id: string;
    /** Display name (provider-specific model name) */
    name: string;
    /** Provider key (e.g. "anthropic", "openai") */
    provider?: string;
    /** Optional user-facing alias */
    alias?: string;
    /** Approximate context window, if advertised */
    contextWindow?: number;
    /** Flat catalog reasoning flag */
    reasoning?: boolean;
    /** Model/session-aware thinking levels, when advertised */
    thinkingLevels?: Array<{ id: string; label?: string }>;
    thinkingOptions?: string[];
    /**
     * Per-model reasoning vocabulary as advertised by the gateway/config — the
     * model's own "lingua franca" (e.g. minimal/low/medium/high, or
     * low/medium/high/xhigh). Preferred source for the reasoning submenu so each
     * model shows only its supported efforts, never a generic union.
     */
    supportedReasoningEfforts?: string[];
    /** OpenClaw thinking-level → provider effort map; its keys are the levels. */
    reasoningEffortMap?: Record<string, string>;
    thinkingLevelMap?: Record<string, string>;
    /** Provider-compat block carrying per-model reasoning capability. */
    compat?: {
        supportedReasoningEfforts?: string[];
        reasoningEffortMap?: Record<string, string>;
    };
    /** Whether this is the default model for the provider */
    default?: boolean;
    /** Model capabilities */
    capabilities?: {
        reasoning?: boolean;
        vision?: boolean;
        streaming?: boolean;
        tools?: boolean;
    };
    /** Optional description */
    description?: string;
}

export interface ProviderGroup {
    /** Provider identifier */
    provider: string;
    /** Display name for the provider */
    providerName?: string;
    /** Models available under this provider */
    models: ModelEntry[];
}

export interface ModelCatalogBrowseView {
    /** Model groups organized by provider */
    providers?: ProviderGroup[];
    /** Flat gateway response shape */
    models?: ModelEntry[];
}

// ────────────────────────────────────────
// Session Types (Group 2 — Session Management)
// ────────────────────────────────────────

export interface SessionEntry {
    /** Session key (e.g. "agent:main:vscode-a1b2c3d4") */
    key: string;
    /** Human-readable label */
    label?: string;
    /** Agent id bound to this session */
    agentId?: string;
    /** Parent session key (for child sessions) */
    parentSessionKey?: string;
    /** Optional session identifier (e.g. JSONL filename stem) */
    sessionId?: string;
    /** Key of the runtime that spawned this session */
    spawnedBy?: string;
    /** Unix timestamp of creation */
    createdAt?: number;
    /** Whether the session is currently active */
    active?: boolean;
}

// ────────────────────────────────────────
// Agent Types
// ────────────────────────────────────────

export interface AgentEntry {
    /** Agent identifier */
    agentId: string;
    /** Display name */
    name?: string;
    /** Agent description */
    description?: string;
    /** Whether the agent is active/running */
    active?: boolean;
}

export interface AgentIdentity {
    name: string;
    displayName?: string;
    emoji?: string;
    description?: string;
}

// ────────────────────────────────────────
// Thinking Level
// ────────────────────────────────────────

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';

// ────────────────────────────────────────
// Agent Request Parameters (for agent method)
// ────────────────────────────────────────

export interface AgentAttachment {
    name: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    mimeType?: string;
}

export interface AgentRequestParams {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
    agentId?: string;
    model?: string;
    provider?: string;
    thinking?: ThinkingLevel;
    attachments?: AgentAttachment[];
    deliver?: boolean;
    bootstrapContextMode?: 'lightweight' | 'full';
}

// ────────────────────────────────────────
// Command Palette Types
// ────────────────────────────────────────

export interface CommandArgChoice {
    /** Choice value */
    value: string;
    /** Display label */
    label?: string;
}

export interface CommandArg {
    /** Argument name */
    name: string;
    /** Human-readable description */
    description?: string;
    /** Valid choices, if any */
    choices?: CommandArgChoice[];
}

export interface CommandEntry {
    /** Command name (without leading /) */
    name: string;
    /** Human-readable description */
    description?: string;
    /** Alternative names */
    aliases?: string[];
    /** Expected arguments */
    args?: CommandArg[];
}

// ────────────────────────────────────────
// Session Model Override Result
// ────────────────────────────────────────

export interface SetSessionModelResult {
    success: boolean;
    /** How the model was set: session-level or per-request */
    method: 'session' | 'per-request';
    /** Error message if session-level patch failed */
    error?: string;
}

// ────────────────────────────────────────
// Session Changed Payload (sessions.changed event)
// ────────────────────────────────────────

export interface SessionChangedPayload {
    /** Session key — NOT "key", field is "sessionKey" */
    sessionKey: string;
    /** Reason for the change — NOT "change", field is "reason" */
    reason: string;
    phase?: string;
    status?: string;
    spawnedBy?: string;
    parentSessionKey?: string;
    spawnDepth?: number;
    subagentRole?: string;
    childSessions?: string[];
}

// ────────────────────────────────────────
// Exec / Plugin Approval Payloads
// ────────────────────────────────────────

export interface ExecApprovalRequestedPayload {
    requestId: string;
    command?: string;
    sessionKey?: string;
}

export interface PluginApprovalRequestedPayload {
    requestId: string;
    pluginId?: string;
    sessionKey?: string;
}

// ────────────────────────────────────────
// Node Pair Requested Payload
// ────────────────────────────────────────

export interface NodePairRequestedPayload {
    nodeName?: string;
}

// ────────────────────────────────────────
// Tool Status Types (Group 5 — ToolStatusManager)
// ────────────────────────────────────────

export interface EffectiveTool {
    /** Tool name (e.g. "read", "exec", "web_search") */
    name: string;
    /** Whether this tool is currently enabled for the agent */
    enabled: boolean;
    /** Optional raw tool definition from the gateway */
    definition?: any;
}

export interface ToolStatus {
    /** All tools with their enabled/disabled state */
    tools: EffectiveTool[];
    /** Web search provider status, if available */
    webSearch?: {
        providers: string[];
        fallbacks: string[];
        activeProvider?: string;
    };
}

// ────────────────────────────────────────
// Model Manager Cache
// ────────────────────────────────────────

export interface ModelCacheState {
    providers: ProviderGroup[];
    timestamp: number;
    /** Auth scopes from connect response */
    authScopes?: string[];
}
