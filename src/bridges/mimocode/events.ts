import { MappedBridgeEvent, EventMappingResult } from '../types';
import { commandOutputToMarkdown, parseGenericCommandOutput } from '../commandOutput';
import { normalizeMiMoToolPart } from './toolParts';

/**
 * Translate MiMoCode SSE stream payloads into Junction stream events.
 *
 * MiMoCode sends two key event types:
 *
 *  - `message.part.updated` — full-state snapshots per part. Each event
 *    contains the complete accumulated text for that part, not a delta.
 *    Parts include `reasoning`, `text`, `tool`, `step-start`, `step-finish`.
 *
 *  - `message.part.delta` — incremental text deltas keyed by partID.
 *    Used for streaming text before the final snapshot arrives.
 *
 * Lifecycle events (start/completed) are owned by MiMoCodeBridge.sendChatMessage;
 * this mapper only emits text, thinking, and tool events.
 *
 * State is maintained across calls via the `state` parameter.
 */
export interface MiMoCodeMapperState {
    /** partIDs identified as reasoning (populated by message.part.updated) */
    reasoningParts: Set<string>;
    /** Latest full reasoning text per partID (message.part.updated snapshots). */
    reasoningAccum: Map<string, string>;
    /** Accumulated text per partID (for delta streaming) */
    textAccum: Map<string, string>;
    /** Last-seen token usage from message.updated events */
    lastUsage?: { inputTokens?: number; outputTokens?: number };
    commandName?: string;
}

export function mapMiMoCodeSseEvent(
    runId: string,
    _eventName: string,
    data: string,
    state: MiMoCodeMapperState,
): EventMappingResult {
    let payload: any = {};
    try { payload = JSON.parse(data); } catch {}

    const events: MappedBridgeEvent[] = [];
    const type: string = payload.type ?? '';

    // Server heartbeat — ignore
    if (type === 'server.heartbeat') {
        return { runId, events };
    }

    // ── message.part.updated — full snapshots ──────────────────────────
    if (type === 'message.part.updated' && payload.properties?.part) {
        const part = payload.properties.part;

        if (part.type === 'reasoning' && part.id) {
            const partID = String(part.id);
            state.reasoningParts.add(partID);
            const full = String(part.text || '');
            const previous = state.reasoningAccum.get(partID) || '';
            const delta = full.startsWith(previous) ? full.slice(previous.length) : full;
            state.reasoningAccum.set(partID, full);
            if (delta) events.push({ type: 'thinking_chunk', runId, text: delta });
        } else if (part.type === 'text' && part.text) {
            state.textAccum.set(part.id ?? '', part.text);
            const commandOutput = state.commandName ? parseGenericCommandOutput(`/${state.commandName}`, part.text) : null;
            events.push({
                type: 'agent_message',
                runId,
                text: commandOutput ? commandOutputToMarkdown(commandOutput) : part.text,
                ...(commandOutput ? { commandOutput } : {}),
            });
        } else if (part.type === 'tool') {
            const tool = normalizeMiMoToolPart(part);
            const status = tool.status;
            const callId = tool.callId;
            if (status === 'running' || status === 'pending') {
                events.push({
                    type: 'tool_event', phase: 'start', runId,
                    toolCallId: callId || `tool-${Math.random().toString(36).slice(2, 8)}`,
                    toolName: tool.name,
                    args: tool.args,
                });
            } else if (status === 'completed' || status === 'error') {
                events.push({
                    type: 'tool_event', phase: 'result', runId,
                    toolCallId: callId,
                    toolName: tool.name,
                    args: tool.args,
                    result: tool.result,
                    isError: tool.isError,
                });
            } else if (status === 'update') {
                events.push({
                    type: 'tool_event', phase: 'update', runId,
                    toolCallId: callId,
                    toolName: tool.name,
                    args: tool.args,
                    result: tool.result,
                });
            }
        }

        return { runId, events };
    }

    // ── message.part.delta — incremental streaming ─────────────────────
    if (type === 'message.part.delta' && payload.properties?.field === 'text' && payload.properties?.delta) {
        const props = payload.properties;
        const partID = props.partID || '';

        if (state.reasoningParts.has(partID)) {
            state.reasoningAccum.set(partID, (state.reasoningAccum.get(partID) ?? '') + props.delta);
            events.push({ type: 'thinking_chunk', runId, text: props.delta });
        } else {
            const prev = state.textAccum.get(partID) ?? '';
            const next = prev + props.delta;
            state.textAccum.set(partID, next);
            const commandOutput = state.commandName ? parseGenericCommandOutput(`/${state.commandName}`, next) : null;
            events.push({
                type: 'agent_message',
                runId,
                text: commandOutput ? commandOutputToMarkdown(commandOutput) : next,
                ...(commandOutput ? { commandOutput } : {}),
            });
        }

        return { runId, events };
    }

    // ── message.updated — legacy full-snapshot ──────────────────────────
    if (type === 'message.updated' && payload.properties?.info) {
        const info = payload.properties.info;
        const parts = Array.isArray(info.parts) ? info.parts : [];

        let fullText = '';
        for (const part of parts) {
            if (part.type === 'text') fullText += part.text || '';
        }

        if (fullText) {
            const commandOutput = state.commandName ? parseGenericCommandOutput(`/${state.commandName}`, fullText) : null;
            events.push({
                type: 'agent_message',
                runId,
                text: commandOutput ? commandOutputToMarkdown(commandOutput) : fullText,
                ...(commandOutput ? { commandOutput } : {}),
            });
        }

        for (const part of parts) {
            if (part.type === 'reasoning') {
                const partID = String(part.id || part.partID || 'legacy-reasoning');
                const full = String(part.text || '');
                const previous = state.reasoningAccum.get(partID) || '';
                const delta = full.startsWith(previous) ? full.slice(previous.length) : full;
                state.reasoningAccum.set(partID, full);
                if (delta) events.push({ type: 'thinking_chunk', runId, text: delta });
            } else if (part.type === 'tool') {
                const tool = normalizeMiMoToolPart(part);
                const status = tool.status;
                const callId = tool.callId;
                if (status === 'running' || status === 'pending') {
                    events.push({
                        type: 'tool_event', phase: 'start', runId,
                        toolCallId: callId || `tool-${Math.random().toString(36).slice(2, 8)}`,
                        toolName: tool.name,
                        args: tool.args,
                    });
                } else if (status === 'completed' || status === 'error') {
                    events.push({
                        type: 'tool_event', phase: 'result', runId,
                        toolCallId: callId,
                        toolName: tool.name,
                        args: tool.args,
                        result: tool.result,
                        isError: tool.isError,
                    });
                } else if (status === 'update') {
                    events.push({
                        type: 'tool_event', phase: 'update', runId,
                        toolCallId: callId,
                        toolName: tool.name,
                        args: tool.args,
                        result: tool.result,
                    });
                }
            }
        }

        // AUDIT: Gateway never sets finish='end' — valid values are 'stop',
        // 'tool-calls', 'content-filter', 'error', 'other'. The 'end' check is
        // dead but harmless. Keep as defensive guard.
        const finished = info.finish === 'stop' || info.finish === 'end';

        // Extract token usage from the server response
        const tokens = info.tokens;
        if (tokens) {
            state.lastUsage = {
                inputTokens: tokens.input ?? tokens.total,
                outputTokens: tokens.output,
            };
        }

        return { runId, events, nextText: fullText, finished, usage: finished ? state.lastUsage : undefined };
    }

    // Auth or permission events — ignore
    if (type.startsWith('auth.') || type.startsWith('permission.')) {
        return { runId, events };
    }

    // Diagnostic events — ignore
    if (type === 'lsp.client.diagnostics') {
        return { runId, events };
    }

    return { runId, events };
}
