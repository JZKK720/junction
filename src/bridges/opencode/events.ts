import { MappedBridgeEvent, EventMappingResult } from '../types';

/**
 * opencode emits a single global SSE stream at GET /event. Each event is
 * `{ type, properties }`. Streaming parts arrive as `message.part.updated`
 * with `properties.part` (a TextPart / ReasoningPart / ToolPart). The turn
 * completes on `session.idle`; failures arrive as `session.error`.
 */
export interface OpenCodeMapperState {
    /** partID -> latest full text (opencode sends snapshots, not deltas). */
    textParts: Map<string, string>;
    reasoningParts: Set<string>;
}

export function newOpenCodeMapperState(): OpenCodeMapperState {
    return { textParts: new Map(), reasoningParts: new Set() };
}

function toolOutput(state: any): string {
    if (state == null) return '';
    if (typeof state.output === 'string') return state.output;
    if (state.output !== undefined) return JSON.stringify(state.output);
    if (typeof state.title === 'string') return state.title;
    return '';
}

export function mapOpenCodeEvent(
    runId: string,
    payload: any,
    state: OpenCodeMapperState,
): EventMappingResult {
    const events: MappedBridgeEvent[] = [];
    const type: string = payload?.type ?? '';
    const props = payload?.properties ?? {};

    if (type === 'message.part.updated') {
        const part = props.part;
        if (!part) return { runId, events };

        if (part.type === 'reasoning') {
            if (part.id) state.reasoningParts.add(part.id);
            events.push({ type: 'thinking_chunk', runId, text: part.text || '' });
        } else if (part.type === 'text') {
            state.textParts.set(part.id || '', part.text || '');
            const full = Array.from(state.textParts.values()).join('');
            events.push({ type: 'agent_message', runId, text: full });
        } else if (part.type === 'tool') {
            const st = part.state || {};
            const callId = part.callID || `tool-${part.id || ''}`;
            if (st.status === 'pending' || st.status === 'running') {
                events.push({
                    type: 'tool_event', phase: 'start', runId,
                    toolCallId: callId,
                    toolName: part.tool || '',
                    args: st.input || {},
                });
            } else if (st.status === 'completed' || st.status === 'error') {
                events.push({
                    type: 'tool_event', phase: 'result', runId,
                    toolCallId: callId,
                    result: toolOutput(st),
                    isError: st.status === 'error',
                });
            }
        }
        return { runId, events };
    }

    if (type === 'session.error') {
        const err = props.error;
        const msg = err?.data?.message || err?.name || 'unknown error';
        events.push({ type: 'agent_message', runId, text: `Error: ${msg}` });
        return { runId, events, finished: true };
    }

    if (type === 'session.idle') {
        return { runId, events, finished: true };
    }

    return { runId, events };
}

/** Build the session id a top-level event refers to (for global-stream routing). */
export function eventSessionId(payload: any): string | null {
    const props = payload?.properties ?? {};
    return (
        props.part?.sessionID ||
        props.info?.sessionID ||
        props.sessionID ||
        null
    );
}
