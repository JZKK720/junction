import { MappedBridgeEvent, EventMappingResult } from '../types';

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
    /** Accumulated text per partID (for delta streaming) */
    textAccum: Map<string, string>;
    /** Last-seen token usage from message.updated events */
    lastUsage?: { inputTokens?: number; outputTokens?: number };
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
            state.reasoningParts.add(part.id);
            if (part.text) {
                events.push({ type: 'thinking_chunk', runId, text: part.text });
            }
        } else if (part.type === 'text' && part.text) {
            state.textAccum.set(part.id ?? '', part.text);
            events.push({ type: 'agent_message', runId, text: part.text });
        } else if (part.type === 'tool') {
            const status = part.status;
            const callId = part.callID || part.call_id || '';
            if (status === 'running' || status === 'pending') {
                events.push({
                    type: 'tool_event', phase: 'start', runId,
                    toolCallId: callId || `tool-${Math.random().toString(36).slice(2, 8)}`,
                    toolName: part.tool || part.name || '',
                    args: part.input || part.args || {},
                });
            } else if (status === 'completed' || status === 'error') {
                events.push({
                    type: 'tool_event', phase: 'result', runId,
                    toolCallId: callId,
                    result: part.output || part.result || '',
                    isError: status === 'error',
                });
            } else if (status === 'update') {
                events.push({
                    type: 'tool_event', phase: 'update', runId,
                    toolCallId: callId,
                    result: part.output || part.result || '',
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
            events.push({ type: 'thinking_chunk', runId, text: props.delta });
        } else {
            const prev = state.textAccum.get(partID) ?? '';
            const next = prev + props.delta;
            state.textAccum.set(partID, next);
            events.push({ type: 'agent_message', runId, text: next });
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
            events.push({ type: 'agent_message', runId, text: fullText });
        }

        for (const part of parts) {
            if (part.type === 'reasoning') {
                events.push({ type: 'thinking_chunk', runId, text: part.text || '' });
            } else if (part.type === 'tool') {
                const status = part.status;
                const callId = part.callID || part.call_id || '';
                if (status === 'running' || status === 'pending') {
                    events.push({
                        type: 'tool_event', phase: 'start', runId,
                        toolCallId: callId || `tool-${Math.random().toString(36).slice(2, 8)}`,
                        toolName: part.tool || part.name || '',
                        args: part.input || part.args || {},
                    });
                } else if (status === 'completed' || status === 'error') {
                    events.push({
                        type: 'tool_event', phase: 'result', runId,
                        toolCallId: callId,
                        result: part.output || part.result || '',
                        isError: status === 'error',
                    });
                } else if (status === 'update') {
                    events.push({
                        type: 'tool_event', phase: 'update', runId,
                        toolCallId: callId,
                        result: part.output || part.result || '',
                    });
                }
            }
        }

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

    // ── tool.execute.before / tool.execute.after ───────────────────────
    if (type === 'tool.execute.before') {
        events.push({
            type: 'tool_event', phase: 'start', runId,
            toolCallId: payload.toolCallID || payload.tool_call_id || `tool-${Math.random().toString(36).slice(2, 8)}`,
            toolName: payload.tool || payload.name || 'unknown',
            args: payload.input || payload.args || {},
        });
    }

    if (type === 'tool.execute.after') {
        events.push({
            type: 'tool_event', phase: 'result', runId,
            toolCallId: payload.toolCallID || payload.tool_call_id || '',
            result: payload.output || payload.result || '',
            isError: !!payload.error,
            durationMs: payload.durationMs,
        });
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
