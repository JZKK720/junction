/**
 * HistoryManager — transcript and session history persistence for Junction chat.
 *
 * Handles:
 * - Transcript turn management (push, clone, persist, restore)
 * - Session history from gateway (restore, loadMore, loadMoreFromJsonl)
 * - History rebuild from gateway messages
 * - Session list population, grouping, archiving
 * - Chat scope filter
 *
 * Extracted from chatBase.ts. Delegates webview postMessage back to ChatBase.
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ToolEventHandler } from './toolEventHandler';
import { loadHistoryMessages } from './history-loader';
import { captureBridgeHistoryDebug } from '../utils/debugCapture';
import type { BridgeMessageReactionTarget, BridgeSession, ChatBridge, SessionGroup } from '../bridges/types';
import type { TranscriptActivityItem, TranscriptTurn, TranscriptTool } from './chatTypes';

export class HistoryManager {
    /** Terminal lifecycle phases across all bridges. */
    static readonly TERMINAL_LIFECYCLE_PHASES = new Set([
        'end', 'finishing', 'completed', 'complete', 'done', 'finished',
        'cancelled', 'canceled', 'aborted', 'failed', 'stopped', 'error',
    ]);

    /**
     * Some models route their reasoning through plain text and separate the
     * user-visible reply with this marker (OpenClaw convention).
     */
    static readonly REPLY_MARKER = '[[reply_to_current]]';

    /**
     * Bare tool-result echoes that some gateways store as assistant turns.
     */
    static readonly TOOL_ECHO_RE =
        /^(Successfully replaced \d+ block|Successfully (?:wrote|created|edited) |No changes made to |File (?:created|written|saved) )/i;

    /**
     * OpenClaw sometimes persists tiny scratchpad crumbs as assistant text
     * records between tool calls. They are not user-facing reply content.
     */
    static readonly ASSISTANT_CRUMB_LINE_RE =
        /^(?:"?>|>|OK(?:\s+(?:so|I|let))?,?|Wait(?:Wait)?|Let|So|The|These|Those|This|Typ|Good|Logger|Files)$/i;

    static readonly ASSISTANT_META_PREFIX_RE =
        /^The user (?:wants|wants me|is|says|said|told me|is frustrated|is telling)\b/i;

    static normalizeAssistantText(text: string): string {
        return String(text || '').replace(/\r\n/g, '\n').trim();
    }

    static isAssistantCrumbLine(text: string): boolean {
        const trimmed = String(text || '').trim();
        if (!trimmed) return false;
        return HistoryManager.ASSISTANT_CRUMB_LINE_RE.test(trimmed)
            || HistoryManager.ASSISTANT_META_PREFIX_RE.test(trimmed);
    }

    static sanitizeAssistantDisplayText(text: string): string {
        const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
        const kept: string[] = [];
        let previousBlank = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                if (kept.length > 0 && !previousBlank) {
                    kept.push('');
                    previousBlank = true;
                }
                continue;
            }
            if (HistoryManager.isAssistantCrumbLine(trimmed)) {
                continue;
            }
            kept.push(line);
            previousBlank = false;
        }

        return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    constructor(
        private readonly makeMessageId: (prefix?: string) => string,
        private readonly visibleTurnContent: (role: string, content: string) => string | null,
        private readonly extractHistoryText: (msg: any) => string,
        private readonly postToWebview: (message: any) => void,
        private readonly renderOptions?: () => Record<string, unknown>,
    ) {}

    private captureDebug(kind: string, payload: any): void {
        const logger = Logger.getInstance() as Logger & { captureDebugStream?: (kind: string, payload: any) => void };
        if (typeof logger.captureDebugStream === 'function') {
            logger.captureDebugStream(kind, payload);
        }
    }

    isTerminalLifecyclePhase(phase: unknown): boolean {
        return typeof phase === 'string'
            && HistoryManager.TERMINAL_LIFECYCLE_PHASES.has(phase.toLowerCase());
    }

    // ── transcript operations ──────────────────────────────────────────────

    cloneTranscript(turns: TranscriptTurn[]): TranscriptTurn[] {
        return turns.map((turn) => ({
            ...turn,
            tools: turn.tools?.map((tool) => ({ ...tool })),
            reactionTarget: turn.reactionTarget ? { ...turn.reactionTarget } : undefined,
        }));
    }

    persistCurrentTranscript(
        sessionTranscripts: Map<string, TranscriptTurn[]>,
        bridge: ChatBridge,
        transcript: TranscriptTurn[]
    ): void {
        const key = bridge.getCurrentSessionKey();
        if (!key || transcript.length === 0) return;
        sessionTranscripts.set(key, this.cloneTranscript(transcript));
    }

    restoreTranscriptFromCache(
        key: string,
        sessionTranscripts: Map<string, TranscriptTurn[]>,
        transcript: TranscriptTurn[],
        runTurnIds: Map<string, string>,
        activeRuns: Map<string, string>,
        renderFn: () => void
    ): { transcript: TranscriptTurn[]; runTurnIds: Map<string, string>; activeRuns: Map<string, string> } | null {
        const saved = sessionTranscripts.get(key);
        if (!saved?.length) return null;
        const restored = this.cloneTranscript(saved);
        const newRunTurnIds = new Map<string, string>();
        const newActiveRuns = new Map<string, string>();
        for (const turn of restored) {
            if (turn.runId) {
                newRunTurnIds.set(turn.runId, turn.id);
                if (turn.role === 'assistant') newActiveRuns.set(turn.runId, turn.content);
            }
        }
        renderFn();
        return { transcript: restored, runTurnIds: newRunTurnIds, activeRuns: newActiveRuns };
    }

    historyMessages(transcript: TranscriptTurn[]): Array<{
        role: string;
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
        reactionTarget?: BridgeMessageReactionTarget;
    }> {
        return transcript
            .map((turn) => {
                const content = this.visibleTurnContent(turn.role, turn.content);
                const hasDebug = !!turn.thinking || !!turn.tools?.length || !!turn.activityTimeline?.length;
                if (content === null && !hasDebug) return null;
                return {
                    role: turn.role,
                    content: content ?? '',
                    runId: turn.runId,
                    messageId: turn.messageId,
                    hasCheckpoint: turn.hasCheckpoint,
                    thinking: turn.thinking,
                    thinkingComplete: turn.thinkingComplete,
                    thinkingDurationMs: turn.thinkingDurationMs,
                    tools: turn.tools,
                    activityTimeline: turn.activityTimeline,
                    reaction: turn.reaction,
                    reactionTarget: turn.reactionTarget,
                };
            })
            .filter((item): item is any => item !== null);
    }

    renderTranscript(transcript: TranscriptTurn[]): void {
        const messages = this.historyMessages(transcript);
        this.captureDebug('chat-history-webview', {
            source: 'renderTranscript',
            inputTurnCount: transcript.length,
            outputCount: messages.length,
            inputTurns: transcript,
            outputMessages: messages,
        });
        this.postToWebview({ type: 'history', messages, ...(this.renderOptions ? this.renderOptions() : {}) });
    }

    // ── session list ───────────────────────────────────────────────────────

    /**
     * Partition flat sessions into collapsible groups: the current
     * workspace folder first + expanded, other folders collapsed, each sorted by
     * recency. Folderless bridges return a single "Recent" group.
     */
    buildSessionGroups(sessions: BridgeSession[]): SessionGroup[] {
        const byId = new Map<string, SessionGroup>();
        for (const s of sessions) {
            const id = s.groupId || 'recent';
            let g = byId.get(id);
            if (!g) {
                g = { id, label: s.groupLabel || id, collapsed: !s.isCurrentGroup, sessions: [] };
                byId.set(id, g);
            }
            g.sessions.push(s);
        }
        const groups = [...byId.values()];
        for (const g of groups) {
            g.sessions.sort((a, b) => (b.lastActiveTs || 0) - (a.lastActiveTs || 0));
        }
        const recencyOf = (g: SessionGroup) => Math.max(0, ...g.sessions.map((s) => s.lastActiveTs || 0));
        const isCurrent = (g: SessionGroup) => g.sessions.some((s) => s.isCurrentGroup);
        groups.sort((a, b) => {
            const ac = isCurrent(a) ? 1 : 0, bc = isCurrent(b) ? 1 : 0;
            if (ac !== bc) return bc - ac;
            return recencyOf(b) - recencyOf(a);
        });
        return groups;
    }

    async pushSessions(
        bridge: ChatBridge,
        chatScope: 'folder' | 'all',
        archivedKeys: Set<string>,
        includeArchived = false
    ): Promise<BridgeSession[] | null> {
        try {
            if (!bridge.capabilities.sessions) return null;
            const sessions = await bridge.listSessions(chatScope, includeArchived, archivedKeys);
            const groups = this.buildSessionGroups(sessions);
            const activeKey = bridge.getCurrentSessionKey() ?? undefined;
            this.postToWebview({ type: 'renderSessions', groups, activeKey });
            return sessions;
        } catch (err) {
            Logger.getInstance().warn('pushSessions failed', err);
            return null;
        }
    }

    // ── history restoration ────────────────────────────────────────────────

    async restoreHistory(
        bridge: ChatBridge,
        transcript: TranscriptTurn[],
        onTurns: (turns: TranscriptTurn[], historyItems: Array<{ role: string; content: string; isSteer?: boolean }>) => void
    ): Promise<void> {
        try {
            const restored = await loadHistoryMessages(bridge, 200);
            const messages = restored.messages;
            this.captureDebug('chat-history-raw', {
                source: 'restoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                inputMessages: messages,
            });
            captureBridgeHistoryDebug(bridge.id, 'history-native', {
                operation: 'restoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                inputMessages: messages,
            });
            if (!Array.isArray(messages) || messages.length === 0) {
                this.renderTranscript(transcript);
                return;
            }
            const turns = this.rebuildTurnsFromGatewayHistory(messages);
            this.captureDebug('chat-history-normalized', {
                source: 'restoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                outputCount: turns.length,
                inputMessages: messages,
                outputTurns: turns,
            });
            captureBridgeHistoryDebug(bridge.id, 'history-normalized', {
                operation: 'restoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                outputCount: turns.length,
                outputTurns: turns,
            });
            if (turns.length > transcript.length) {
                onTurns(turns, turns.map((turn) => ({ role: turn.role, content: turn.content, isSteer: turn.isSteer })));
            }
            this.renderTranscript(turns);
        } catch (error: any) {
            Logger.getInstance().warn('restoreHistory failed', error);
        }
    }

    async handleLoadMoreHistory(
        bridge: ChatBridge,
        transcript: TranscriptTurn[],
        onTurns: (turns: TranscriptTurn[], historyItems: Array<{ role: string; content: string; isSteer?: boolean }>) => void
    ): Promise<void> {
        try {
            const restored = await loadHistoryMessages(bridge, 1000);
            const messages = restored.messages;
            this.captureDebug('chat-history-raw', {
                source: 'handleLoadMoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                inputMessages: messages,
            });
            captureBridgeHistoryDebug(bridge.id, 'history-native', {
                operation: 'handleLoadMoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                inputMessages: messages,
            });
            if (!Array.isArray(messages) || messages.length === 0) {
                this.postToWebview({ type: 'noMoreHistory' });
                return;
            }
            const turns = this.rebuildTurnsFromGatewayHistory(messages);
            this.captureDebug('chat-history-normalized', {
                source: 'handleLoadMoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                outputCount: turns.length,
                inputMessages: messages,
                outputTurns: turns,
            });
            captureBridgeHistoryDebug(bridge.id, 'history-normalized', {
                operation: 'handleLoadMoreHistory',
                historySource: restored.source,
                sessionKey: bridge.getCurrentSessionKey(),
                inputCount: messages.length,
                outputCount: turns.length,
                outputTurns: turns,
            });
            if (turns.length > transcript.length) {
                onTurns(turns, turns.map((turn) => ({ role: turn.role, content: turn.content, isSteer: turn.isSteer })));
            }
            this.renderTranscript(turns);
            this.postToWebview({ type: 'noMoreHistory' });
        } catch (error: any) {
            Logger.getInstance().warn('handleLoadMoreHistory failed', error);
        }
    }

    async handleLoadMoreHistoryFromJsonl(
        bridge: ChatBridge,
        offset: number = 0
    ): Promise<void> {
        try {
            const sessionKey = bridge.getCurrentSessionKey();
            if (!sessionKey || !(bridge as any).getSessionHistoryFromJsonl) {
                // Fall back — caller should handle this
                return;
            }
            const result = await (bridge as any).getSessionHistoryFromJsonl(sessionKey, offset, 256 * 1024);
            if (!result || !result.messages || result.messages.length === 0) {
                return; // Caller should fall back
            }
            this.captureDebug('chat-history-raw', {
                source: 'handleLoadMoreHistoryFromJsonl',
                historySource: 'jsonl-fallback',
                sessionKey,
                offset,
                inputCount: result.messages.length,
                inputMessages: result.messages,
            });
            const turns = this.rebuildTurnsFromGatewayHistory(result.messages);
            this.captureDebug('chat-history-normalized', {
                source: 'handleLoadMoreHistoryFromJsonl',
                sessionKey,
                offset,
                inputCount: result.messages.length,
                outputCount: turns.length,
                inputMessages: result.messages,
                outputTurns: turns,
            });
            this.postToWebview({
                type: 'moreHistory',
                turns,
                hasMore: result.hasMore,
                nextOffset: result.nextOffset,
            });
        } catch (error: any) {
            Logger.getInstance().warn('handleLoadMoreHistoryFromJsonl failed', error);
        }
    }

    // ── transcript rebuild ─────────────────────────────────────────────────

    /**
     * Rebuild full transcript turns from gateway history, shaped as a chat
     * transcript: one assistant turn per user→reply cycle.
     */
    rebuildTurnsFromGatewayHistory(messages: any[]): TranscriptTurn[] {
        const turns: TranscriptTurn[] = [];
        const toolIndex = new Map<string, TranscriptTool>();
        const seenAssistantTextsSinceVisibleUser = new Set<string>();
        let current: TranscriptTurn | null = null;
        let thinkingBuf: string[] = [];
        let contentBuf: string[] = [];
        let activityTimeline: TranscriptActivityItem[] = [];

        const flush = () => {
            if (!current) return;
            current.content = contentBuf.join('\n\n');
            const thinking = thinkingBuf.join('\n\n');
            if (thinking) {
                current.thinking = thinking;
                current.thinkingComplete = true;
            }
            if (current.tools && current.tools.length === 0) current.tools = undefined;
            if (activityTimeline.length) current.activityTimeline = activityTimeline.slice();
            if (current.content || current.thinking || current.tools?.length || current.activityTimeline?.length) turns.push(current);
            current = null;
            thinkingBuf = [];
            contentBuf = [];
            activityTimeline = [];
        };

        const pushActivityNote = (raw: string) => {
            const text = HistoryManager.sanitizeAssistantDisplayText(raw);
            if (!text) return;
            const last = activityTimeline[activityTimeline.length - 1];
            if (last?.type === 'note' && last.text) {
                last.text += '\n\n' + text;
            } else {
                activityTimeline.push({ type: 'note', text });
            }
        };

        const route = (raw: string, defaultToThinking: boolean, forceTimeline = false) => {
            const t = String(raw ?? '').trim();
            if (!t) return;
            const idx = t.indexOf(HistoryManager.REPLY_MARKER);
            if (idx >= 0) {
                const before = t.slice(0, idx).trim();
                const after = t.slice(idx + HistoryManager.REPLY_MARKER.length).trim();
                if (before) {
                    thinkingBuf.push(before);
                    pushActivityNote(before);
                }
                if (after) contentBuf.push(after);
                return;
            }
            if (defaultToThinking || forceTimeline) {
                if (defaultToThinking) thinkingBuf.push(t);
                pushActivityNote(t);
                return;
            }
            contentBuf.push(t);
        };

        for (const msg of messages) {
            const m = msg?.message ?? msg;
            const role = msg?.role || m?.role;
            if (role === 'user') {
                flush();
                const content = this.extractHistoryText(msg);
                const visible = content ? this.visibleTurnContent('user', content) : null;
                if (visible) {
                    seenAssistantTextsSinceVisibleUser.clear();
                    turns.push({
                        id: this.makeMessageId('m'),
                        role: 'user',
                        content: visible,
                        isSteer: !!(msg.isSteer || m?.isSteer),
                    });
                }
                continue;
            }
            if (role === 'assistant') {
                const stopReason = String(msg?.stopReason ?? m?.stopReason ?? '').toLowerCase();
                const isToolUseStep = stopReason === 'tooluse' || stopReason === 'tool_use' || stopReason === 'tool-use';
                const parts = Array.isArray(m?.content)
                    ? m.content
                    : (typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);
                const plainTextParts: string[] = [];
                let hasNonTextDebug = false;
                for (const part of parts) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.type === 'thinking' || part.type === 'reasoning' || part.type === 'toolCall' || part.type === 'tool_use' || part.type === 'tool-call') {
                        hasNonTextDebug = true;
                        continue;
                    }
                    if (typeof part.text === 'string') {
                        const sanitized = HistoryManager.sanitizeAssistantDisplayText(part.text);
                        const visible = sanitized ? this.visibleTurnContent('assistant', sanitized) : null;
                        const normalizedPart = HistoryManager.normalizeAssistantText(visible || '');
                        if (
                            visible
                            && !HistoryManager.TOOL_ECHO_RE.test(visible.trim())
                            && !seenAssistantTextsSinceVisibleUser.has(normalizedPart)
                        ) {
                            plainTextParts.push(visible);
                        }
                    }
                }
                const normalizedAssistantText = HistoryManager.normalizeAssistantText(plainTextParts.join('\n\n'));
                if (normalizedAssistantText && !hasNonTextDebug && seenAssistantTextsSinceVisibleUser.has(normalizedAssistantText)) {
                    continue;
                }
                if (!current) {
                    current = { id: this.makeMessageId('a'), role: 'assistant', content: '', tools: [] };
                }
                for (const part of parts) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.type === 'thinking' || part.type === 'reasoning') {
                        route(String(part.thinking ?? part.text ?? ''), true);
                        continue;
                    }
                    if (part.type === 'toolCall' || part.type === 'tool_use' || part.type === 'tool-call') {
                        const hasResult = part.result !== undefined || part.output !== undefined;
                        const tool: TranscriptTool = {
                            toolCallId: String(part.id ?? part.toolCallId ?? `restored:${toolIndex.size}`),
                            toolName: String(part.name ?? part.toolName ?? ''),
                            args: ToolEventHandler.formatToolArgs(part.arguments ?? part.input ?? part.args ?? {}),
                            phase: hasResult ? 'result' : 'start',
                        };
                        if (hasResult) {
                            tool.result = ToolEventHandler.formatToolResult(part.result ?? part.output ?? '', !!part.isError);
                            tool.isError = !!part.isError;
                        }
                        current.tools!.push(tool);
                        toolIndex.set(tool.toolCallId, tool);
                        activityTimeline.push({ type: 'tool', toolCallId: tool.toolCallId });
                        continue;
                    }
                    if (typeof part.text === 'string') {
                        const sanitized = HistoryManager.sanitizeAssistantDisplayText(part.text);
                        const visible = sanitized ? this.visibleTurnContent('assistant', sanitized) : null;
                        const normalizedPart = HistoryManager.normalizeAssistantText(visible || '');
                        if (
                            visible
                            && !HistoryManager.TOOL_ECHO_RE.test(visible.trim())
                            && !seenAssistantTextsSinceVisibleUser.has(normalizedPart)
                        ) {
                            route(visible, false, isToolUseStep);
                        }
                    }
                }
                if (normalizedAssistantText) seenAssistantTextsSinceVisibleUser.add(normalizedAssistantText);
                continue;
            }
            if (role === 'toolResult' || role === 'tool' || role === 'tool_result') {
                const id = String(m?.toolCallId ?? m?.tool_call_id ?? '');
                if (!current) {
                    current = { id: this.makeMessageId('a'), role: 'assistant', content: '', tools: [] };
                }
                if (!current.tools) current.tools = [];
                let tool = id ? toolIndex.get(id) : undefined;
                if (!tool) {
                    tool = {
                        toolCallId: id || `restored:${toolIndex.size}`,
                        toolName: m?.toolName ? String(m.toolName) : '',
                        phase: 'start',
                    };
                    current.tools.push(tool);
                    toolIndex.set(tool.toolCallId, tool);
                    activityTimeline.push({ type: 'tool', toolCallId: tool.toolCallId });
                }
                if (tool) {
                    const resultText = this.extractHistoryText(msg);
                    tool.result = ToolEventHandler.formatToolResult(resultText || m?.content || '', !!m?.isError);
                    tool.isError = !!m?.isError;
                    tool.phase = 'result';
                    if (m?.toolName && !tool.toolName) tool.toolName = String(m.toolName);
                }
                continue;
            }
        }
        flush();
        const deduped = this.dedupeAssistantEchoTurns(turns);
        this.captureDebug('history-rebuild', {
            source: 'rebuildTurnsFromGatewayHistory',
            inputCount: messages.length,
            preDedupeCount: turns.length,
            outputCount: deduped.length,
            inputMessages: messages,
            preDedupeTurns: turns,
            outputTurns: deduped,
        });
        this.captureDebug('chat-history-normalized', {
            source: 'rebuildTurnsFromGatewayHistory',
            inputCount: messages.length,
            preDedupeCount: turns.length,
            outputCount: deduped.length,
            inputMessages: messages,
            preDedupeTurns: turns,
            outputTurns: deduped,
        });
        return deduped;
    }

    dedupeAssistantEchoTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
        const kept: TranscriptTurn[] = [];
        const seenSinceVisibleUser = new Map<string, TranscriptTurn>();

        for (const turn of turns) {
            if (turn.role === 'user') {
                kept.push(turn);
                seenSinceVisibleUser.clear();
                continue;
            }
            if (turn.role !== 'assistant') {
                kept.push(turn);
                continue;
            }

            const normalized = HistoryManager.normalizeAssistantText(turn.content);
            const previous = normalized ? seenSinceVisibleUser.get(normalized) : undefined;
            const hasDebug = !!(turn.thinking || turn.tools?.length);
            if (previous && !hasDebug) {
                continue;
            }

            kept.push(turn);
            if (normalized) {
                const previousDebug = !!(previous?.thinking || previous?.tools?.length);
                if (!previous || (!previousDebug && hasDebug)) {
                    seenSinceVisibleUser.set(normalized, turn);
                }
            }
        }

        return kept;
    }
}
