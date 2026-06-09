import { EventEmitter } from 'events';
import * as vscode from 'vscode';

export type BridgeId = 'openclaw' | 'hermes' | 'souveraine' | (string & {});
export type ChatScope = 'folder' | 'all';

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
}

export interface BridgeCapabilities {
    sessions: boolean;
    models: boolean;
    agents: boolean;
    steering: boolean;
    usage: boolean;
    tools: boolean;
    planReviewMode: boolean;
    planExecutionMode: boolean;
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
    createChat(folderUri?: vscode.Uri): Promise<string>;
    listSessions(scope: ChatScope, includeArchived: boolean, archivedKeys: ReadonlySet<string>): Promise<BridgeSession[]>;
    renameSession(key: string, label: string): Promise<void>;
    getSessionHistory(limit?: number, folderUri?: vscode.Uri): Promise<any>;
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

export const hiddenPlanCapabilities = {
    planReviewMode: true,
    planExecutionMode: true,
};
