/**
 * Shared types used by ChatBase and its extracted modules.
 */

export interface AttachedPill {
    filePath: string;
    displayText: string;
    isLive: boolean;
    startLine?: number;
    endLine?: number;
    language?: string;
    selectedText?: string;
}

export interface TranscriptTurn {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    runId?: string;
    messageId?: string;
    hasCheckpoint?: boolean;
    thinking?: string;
    thinkingComplete?: boolean;
    thinkingDurationMs?: number;
    tools?: TranscriptTool[];
    activityTimeline?: TranscriptActivityItem[];
    reaction?: 'up' | 'down' | null;
    isSteer?: boolean;
}

export interface TranscriptTool {
    toolCallId: string;
    toolName?: string;
    args?: string;
    updates?: string;
    result?: string;
    isError?: boolean;
    phase?: 'start' | 'update' | 'result';
}

export interface TranscriptActivityItem {
    type: 'note' | 'tool';
    text?: string;
    toolCallId?: string;
}

export interface WebviewConfigPayload {
    type: 'config';
    sendBehavior: 'enter' | 'ctrlEnter' | 'smartEnter';
    reasoningDisplay: string;
    extraRichText: boolean;
    activityLayout: string;
    activityRail: boolean;
    activityDots: string;
    showFullHistory: boolean;
    steerKeybinding: string;
    animConfig?: any;
    animationMode?: string;
    animColor?: string;
    loaderColor?: string;
    splashColor?: string;
    tokenColors?: Record<string, string>;
}

export const LEGACY_VSCODE_WORKSPACE_CONTEXT_PREFIX = 'This session is driven from the VS Code extension.';
