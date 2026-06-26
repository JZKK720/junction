import { EventEmitter } from 'events';
import * as vscode from 'vscode';

export type BridgeId = 'openclaw' | 'hermes' | 'souveraine' | 'mimocode' | 'goose' | 'opencode' | 'pi' | 'openhands' | (string & {});
export type ChatScope = 'folder' | 'all';

/**
 * OpenClaw's canonical thinking-level vocabulary — the lingua franca for any
 * reasoning-capable model that doesn't advertise a named per-model effort enum
 * (e.g. xiaomi/deepseek/ollama). Used as the always-on fallback so the reasoning
 * submenu is never empty for a reasoning model. The selected level is sent as the
 * per-request `thinking` param; the gateway coerces it to the model's nearest
 * supported value.
 */
export const OPENCLAW_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
export const VSCODE_WORKSPACE_CONTEXT_PREFIX = 'Chat: VS Code.';
export const WORKSPACE_LINE_PREFIX_RE = /^\[Workspace: [^\]\n]*\]\n/;

export interface ChoiceMenuItem {
    id: string;
    label: string;
    description?: string;
    section?: string;
    icon?: string;
    checked?: boolean;
    disabled?: boolean;
    children?: ChoiceMenuItem[];
    [key: string]: unknown;
}

export interface ModelChoice extends ChoiceMenuItem {
    provider?: string;
    model?: string;
    supportsReasoning?: boolean;
    thinking?: string;
    /** Per-model thinking levels from the bridge; falls back to OPENCLAW_THINKING_LEVELS. */
    thinkingLevels?: string[];
}

export interface BridgeSession {
    key: string;
    title: string;
    model?: string;
    isActive?: boolean;
    isArchived?: boolean;
    /** Grouping key (e.g. folder binding id, or 'recent' for folderless bridges). */
    groupId?: string;
    /** Human label for the group header. */
    groupLabel?: string;
    /** True when this session's group is the current workspace folder (expanded by default). */
    isCurrentGroup?: boolean;
    /** Epoch ms of last activity, for ordering. */
    lastActiveTs?: number;
    /** Message count for the card meta row, when known. */
    messageCount?: number;
    /** Optional native workspace URI/path for bridges that persist cwd per session. */
    workspaceUri?: string;
    workspaceName?: string;
}

/** A collapsible group of sessions in the chats list. */
export interface SessionGroup {
    id: string;
    label: string;
    collapsed: boolean;
    sessions: BridgeSession[];
}

export interface BridgeCapabilities {
    sessions: boolean;
    models: boolean;
    agents: boolean;
    steering: boolean;
    usage: boolean;
    tools: boolean;
    /** Native gateway-backed message reactions for assistant replies. */
    messageReactions?: boolean;
    /** This bridge emits native reasoning/tool events in chronological order, so
     *  timeline mode should keep thoughts interleaved with tools rather than
     *  pinning/coalescing all thoughts above the tool stream. Opt-in per bridge;
     *  consumed by render/timeline-interleave.js. Default false. */
    timelineInterleaves?: boolean;
    /** Raw thinking is streamed natively and should not be echoed as assistant
     *  message text while a reasoning stream is active. Reasoning still renders
     *  in the activity/timeline UI. Default false. */
    hidesRawThinking?: boolean;
    /** Whether junction can control this bridge's sandbox/approval modes. When
     *  explicitly false, the composer hides the sandbox/approvals chip (the
     *  bridge has no junction-controllable permission model). Default: shown. */
    sandboxControls?: boolean;
}

export interface BridgeContext {
    workspace?: string;
    workspaceFolder?: string;
    activeFile?: string;
    language?: string;
    selection?: { start: number; end: number } | null;
}

export interface BridgeMessageReactionTarget {
    sessionKey?: string;
    messageId?: string;
    nativeMessageId?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    [key: string]: unknown;
}

export interface BridgeSelectionState {
    modelId?: string;
    thinking?: string;
    agentId?: string;
}

export interface ToolStatusView {
    tools: Array<{ name: string; enabled: boolean }>;
}

// ── Event mapping (per-bridge adapter contract) ───────────────────────────

/** A single event emitted by a bridge adapter into the Junction stream. */
export interface MappedBridgeEvent {
    type: string;
    [key: string]: unknown;
}

/** Result returned by a bridge's event mapper function. */
export interface EventMappingResult {
    runId: string;
    events: MappedBridgeEvent[];
    /** Accumulated full text for text-based bridges (Souveraine, Hermes). */
    nextText?: string;
    /** MiMoCode: true when the server signals finish (stop/end). */
    finished?: boolean;
    /** Hermes: true when the buffer should be cleared on completion. */
    clearBuffer?: boolean;
    /** Token usage extracted from server response (MiMoCode). */
    usage?: { inputTokens?: number; outputTokens?: number };
}

// ── History adapter (per-bridge contract) ────────────────────────────────

/** Normalized message shape returned by getSessionHistory(). */
export interface HistoryMessage {
    role: 'user' | 'assistant';
    /** Content parts — array for assistant (reasoning/text/toolCall), string for user. */
    content: string | HistoryPart[];
    isSteer?: boolean;
}

/** A single part in an assistant message's content array. */
export interface HistoryPart {
    type: 'text' | 'reasoning' | 'thinking' | 'toolCall' | 'tool_use' | 'tool-call';
    text?: string;
    thinking?: string;
    name?: string;
    toolName?: string;
    toolCallId?: string;
    id?: string;
    arguments?: any;
    input?: any;
    args?: any;
    [key: string]: unknown;
}

export interface ChatBridge extends EventEmitter {
    readonly id: BridgeId;
    readonly label: string;
    readonly context: vscode.ExtensionContext;
    readonly capabilities: BridgeCapabilities;

    connect(): Promise<boolean>;
    disconnect(): void;
    isConnected(): boolean;
    initializeWorkspace(): Promise<void>;
    registerRuntimeIntegrations(): Promise<void>;
    configure(): Promise<void>;

    getCurrentSessionKey(folderUri?: vscode.Uri): string | null;
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri>;
    setActiveSession(folderUri: vscode.Uri, key: string): void;
    bindSessionWorkspace?(sessionKey: string | null | undefined, folderUri?: vscode.Uri): void;
    boundSessionWorkspace?(sessionKey: string | null | undefined): vscode.Uri | undefined;
    /**
     * Transport-level scoping for shared-gateway bridges: a view declares
     * which session's conversation stream it displays; events for unwatched
     * sessions are dropped at the connection. Single-session bridges may omit.
     */
    watchSession?(key: string): void;
    unwatchSession?(key: string): void;
    createChat(folderUri?: vscode.Uri): Promise<string>;
    forkChat?(parentSessionKey: string, folderUri?: vscode.Uri): Promise<string | null>;
    listSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]>;
    listWorkspaceSessions?(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>, currentFolder?: vscode.Uri): Promise<BridgeSession[]>;
    renameSession(key: string, label: string): Promise<void>;
    getSessionHistory(limit?: number, folderUri?: vscode.Uri): Promise<any>;
    getSessionHistoryFromJsonl?(sessionKey: string, offset?: number, maxBytes?: number): Promise<any>;
    sendChatMessage(message: string, context?: BridgeContext): Promise<any>;
    setMessageReaction?(target: BridgeMessageReactionTarget, value: 'up' | 'down' | null): Promise<void>;
    executeSlashCommand?(command: string, context?: BridgeContext): Promise<any>;
    stopRun(sessionKey: string, runId?: string): Promise<void>;
    getUsage(sessionKey: string): Promise<any>;
    injectMessage(sessionKey: string, message: string): Promise<boolean>;
    /** Bridge-native hidden/session context injection. Junction uses this for
     * cwd/workspace facts; fallback is bridge.injectMessage when safe. */
    injectHiddenContext?(sessionKey: string, context: BridgeContext, message: string): Promise<boolean>;
    canSteer(): boolean;
    canAdminInject(): boolean;

    /**
     * Resolve a blocking approval prompt the bridge surfaced via an
     * `approval_request` stream event. `choice` is the gateway vocabulary
     * (`once` | `session` | `always` | `deny`); `all` resolves every pending
     * approval in the session at once. Bridges without interactive approvals
     * may omit this. */
    respondApproval?(data: { requestId?: string; choice: string; all?: boolean }): Promise<void>;
    /**
     * Resolve a blocking input prompt surfaced via an `input_request` stream
     * event (secret / sudo / clarify / terminal-read). `kind` selects the
     * response transport; `value` is the user-entered text. */
    respondInput?(data: { requestId: string; kind: string; value: string }): Promise<void>;
    /**
     * Manually compact / summarize the session's context. Surfaced by the
     * context-usage meter; bridges without compaction may omit it. */
    compactContext?(sessionKey: string): Promise<void>;
    /**
     * Report context-window usage for the meter. `percentUsed` is omitted when
     * the context window size is unknown (meter then shows raw token count). */
    getContextUsage?(sessionKey: string): Promise<{ percentUsed?: number; usedTokens?: number; contextWindow?: number } | null>;

    getSelection?(): BridgeSelectionState;
    setSelection(selection: BridgeSelectionState): void;
    listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]>;
    selectModelChoice(data: any, sessionKey?: string | null): Promise<{ display: string; modelId: string; thinking?: string; perRequestOnly?: boolean } | null>;
    listEnvironmentChoices(): Promise<ChoiceMenuItem[]>;
    selectEnvironmentChoice(data: any): Promise<void>;
    getEnvironmentLabel(): string;
    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> | Promise<Array<{ name: string; description?: string }>>;
    getToolStatus(): ToolStatusView | null;
}
