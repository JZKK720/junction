import { EventEmitter } from 'events';
import * as vscode from 'vscode';

export type BridgeId = 'openclaw' | 'hermes' | 'souveraine' | (string & {});
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
}

export interface BridgeContext {
    workspace?: string;
    workspaceFolder?: string;
    activeFile?: string;
    language?: string;
    selection?: { start: number; end: number } | null;
}

export interface BridgeSelectionState {
    modelId?: string;
    thinking?: string;
    agentId?: string;
}

export interface ToolStatusView {
    tools: Array<{ name: string; enabled: boolean }>;
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
    getSettingsQuery(): string;

    setPendingFileContext(context: string): void;
    getPendingFileContext(): string | null;

    getCurrentSessionKey(folderUri?: vscode.Uri): string | null;
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri>;
    setActiveSession(folderUri: vscode.Uri, key: string): void;
    /**
     * Transport-level scoping for shared-gateway bridges: a view declares
     * which session's conversation stream it displays; events for unwatched
     * sessions are dropped at the connection. Single-session bridges may omit.
     */
    watchSession?(key: string): void;
    unwatchSession?(key: string): void;
    createChat(folderUri?: vscode.Uri): Promise<string>;
    listSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]>;
    renameSession(key: string, label: string): Promise<void>;
    getSessionHistory(limit?: number, folderUri?: vscode.Uri): Promise<any>;
    getSessionHistoryFromJsonl?(sessionKey: string, offset?: number, maxBytes?: number): Promise<any>;
    sendChatMessage(message: string, context?: BridgeContext): Promise<any>;
    stopRun(sessionKey: string, runId?: string): Promise<void>;
    getUsage(sessionKey: string): Promise<any>;
    injectMessage(sessionKey: string, message: string): Promise<boolean>;
    canSteer(): boolean;
    canAdminInject(): boolean;

    setSelection(selection: BridgeSelectionState): void;
    listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]>;
    selectModelChoice(data: any, sessionKey?: string | null): Promise<{ display: string; modelId: string; thinking?: string; perRequestOnly?: boolean } | null>;
    listEnvironmentChoices(): Promise<ChoiceMenuItem[]>;
    selectEnvironmentChoice(data: any): Promise<void>;
    getEnvironmentLabel(): string;
    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }>;
    getToolStatus(): ToolStatusView | null;
}
