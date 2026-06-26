import { MappedBridgeEvent, EventMappingResult } from '../types';
import { commandOutputToMarkdown, parseGenericCommandOutput } from '../commandOutput';

/**
 * opencode emits a location-scoped SSE stream at GET /api/event. Older dev
 * builds used `{ type, properties }`; current v2 emits `{ type, data }`.
 * Streaming parts arrive as `message.part.updated` with `part` data.
 * Turn completes on `session.idle`; failures arrive as `session.error`.
 */
export interface OpenCodeMapperState {
    /** partID -> latest full text (opencode sends snapshots, not deltas). */
    textParts: Map<string, string>;
    /** partID -> latest full reasoning text (opencode sends snapshots, not deltas). */
    reasoningTextParts: Map<string, string>;
    reasoningParts: Set<string>;
    toolNames: Map<string, string>;
    toolInputs: Map<string, string>;
    commandName?: string;
}

export function newOpenCodeMapperState(): OpenCodeMapperState {
    return {
        textParts: new Map(),
        reasoningTextParts: new Map(),
        reasoningParts: new Set(),
        toolNames: new Map(),
        toolInputs: new Map(),
    };
}

function toolOutput(state: any): string {
    if (state == null) return '';
    if (typeof state.output === 'string') return state.output;
    if (state.output !== undefined) return JSON.stringify(state.output);
    if (typeof state.title === 'string') return state.title;
    return '';
}

function contentToText(content: any): string {
    if (!Array.isArray(content)) return '';
    return content.map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
    }).filter(Boolean).join('\n');
}

function resultText(data: any): string {
    if (data?.result !== undefined) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const content = contentToText(data?.content);
    if (content) return content;
    if (data?.error?.message) return String(data.error.message);
    return '';
}

export function mapOpenCodeEvent(
    runId: string,
    payload: any,
    state: OpenCodeMapperState,
): EventMappingResult {
    const events: MappedBridgeEvent[] = [];
    const type: string = payload?.type ?? '';
    const props = payload?.properties ?? payload?.data ?? {};

    if (type === 'session.next.reasoning.started') {
        if (props.reasoningID) state.reasoningParts.add(props.reasoningID);
        return { runId, events };
    }

    if (type === 'session.next.reasoning.delta') {
        const id = props.reasoningID || props.assistantMessageID || 'reasoning';
        const delta = String(props.delta || '');
        if (id) {
            state.reasoningParts.add(id);
            state.reasoningTextParts.set(id, (state.reasoningTextParts.get(id) || '') + delta);
        }
        if (delta) events.push({ type: 'thinking_chunk', runId, text: delta });
        return { runId, events };
    }

    if (type === 'session.next.reasoning.ended') {
        const id = props.reasoningID || props.assistantMessageID || 'reasoning';
        const full = String(props.text || '');
        const previous = state.reasoningTextParts.get(id) || '';
        const delta = full && !previous ? full : (full.startsWith(previous) ? full.slice(previous.length) : '');
        state.reasoningTextParts.set(id, full || previous);
        if (delta) events.push({ type: 'thinking_chunk', runId, text: delta });
        return { runId, events };
    }

    if (type === 'session.next.text.delta') {
        const id = props.textID || props.assistantMessageID || 'text';
        const delta = String(props.delta || '');
        state.textParts.set(id, (state.textParts.get(id) || '') + delta);
        const full = Array.from(state.textParts.values()).join('');
        const commandOutput = state.commandName ? parseGenericCommandOutput(`/${state.commandName}`, full) : null;
        events.push({
            type: 'agent_message',
            runId,
            text: commandOutput ? commandOutputToMarkdown(commandOutput) : full,
            ...(commandOutput ? { commandOutput } : {}),
        });
        return { runId, events };
    }

    if (type === 'session.next.text.ended') {
        const id = props.textID || props.assistantMessageID || 'text';
        const fullText = String(props.text || '');
        state.textParts.set(id, fullText);
        const full = Array.from(state.textParts.values()).join('');
        const commandOutput = state.commandName ? parseGenericCommandOutput(`/${state.commandName}`, full) : null;
        events.push({
            type: 'agent_message',
            runId,
            text: commandOutput ? commandOutputToMarkdown(commandOutput) : full,
            ...(commandOutput ? { commandOutput } : {}),
        });
        return { runId, events };
    }

    if (type === 'session.next.tool.input.started') {
        const callId = props.callID || '';
        if (callId) {
            state.toolNames.set(callId, String(props.name || ''));
            state.toolInputs.set(callId, '');
            events.push({
                type: 'tool_event', phase: 'start', runId,
                toolCallId: callId,
                toolName: String(props.name || ''),
                args: {},
            });
        }
        return { runId, events };
    }

    if (type === 'session.next.tool.input.delta') {
        const callId = props.callID || '';
        if (callId) state.toolInputs.set(callId, (state.toolInputs.get(callId) || '') + String(props.delta || ''));
        return { runId, events };
    }

    if (type === 'session.next.tool.called') {
        const callId = props.callID || '';
        if (callId) {
            state.toolNames.set(callId, String(props.tool || props.name || state.toolNames.get(callId) || ''));
            events.push({
                type: 'tool_event', phase: 'start', runId,
                toolCallId: callId,
                toolName: state.toolNames.get(callId) || '',
                args: props.input || {},
            });
        }
        return { runId, events };
    }

    if (type === 'session.next.tool.success' || type === 'session.next.tool.failed') {
        const callId = props.callID || '';
        if (callId) {
            events.push({
                type: 'tool_event', phase: 'result', runId,
                toolCallId: callId,
                toolName: state.toolNames.get(callId) || props.tool || props.name || '',
                result: resultText(props),
                isError: type === 'session.next.tool.failed',
            });
        }
        return { runId, events };
    }

    if (type === 'session.next.step.ended') {
        return { runId, events, finished: true };
    }

    if (type === 'session.next.step.failed') {
        const msg = props.error?.message || props.error?.data?.message || 'unknown error';
        events.push({ type: 'agent_message', runId, text: `Error: ${msg}` });
        return { runId, events, finished: true };
    }

    if (type === 'message.part.updated') {
        const part = props.part;
        if (!part) return { runId, events };

        if (part.type === 'reasoning') {
            const id = part.id || '';
            if (id) state.reasoningParts.add(id);
            const full = String(part.text || '');
            const previous = state.reasoningTextParts.get(id) || '';
            const delta = full.startsWith(previous) ? full.slice(previous.length) : full;
            state.reasoningTextParts.set(id, full);
            if (delta) events.push({ type: 'thinking_chunk', runId, text: delta });
        } else if (part.type === 'text') {
            state.textParts.set(part.id || '', part.text || '');
            const full = Array.from(state.textParts.values()).join('');
            const commandOutput = state.commandName ? parseGenericCommandOutput(`/${state.commandName}`, full) : null;
            events.push({
                type: 'agent_message',
                runId,
                text: commandOutput ? commandOutputToMarkdown(commandOutput) : full,
                ...(commandOutput ? { commandOutput } : {}),
            });
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
    const props = payload?.properties ?? payload?.data ?? {};
    return (
        props.part?.sessionID ||
        props.info?.sessionID ||
        props.session?.id ||
        props.sessionID ||
        props.sessionId ||
        props.input?.sessionID ||
        null
    );
}
