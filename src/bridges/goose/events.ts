import { MappedBridgeEvent, EventMappingResult } from '../types';

export interface GooseMapperState {
    reasoningParts: Set<string>;
    textAccum: Map<string, string>;
}

export function mapGooseSseEvent(
    runId: string,
    _eventName: string,
    data: string,
    state: GooseMapperState,
): EventMappingResult {
    let payload: any = {};
    try { payload = JSON.parse(data); } catch {}

    const events: MappedBridgeEvent[] = [];
    const type: string = payload.type ?? '';

    if (type === 'server.heartbeat') return { runId, events };

    if (type === 'message.part.updated' && payload.properties?.part) {
        const part = payload.properties.part;
        if (part.type === 'reasoning' && part.id) {
            state.reasoningParts.add(part.id);
            if (part.text) events.push({ type: 'thinking_chunk', runId, text: part.text });
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
            }
        }
        return { runId, events };
    }

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

    if (type === 'message.updated' && payload.properties?.info) {
        const info = payload.properties.info;
        const parts = Array.isArray(info.parts) ? info.parts : [];
        let fullText = '';
        for (const part of parts) {
            if (part.type === 'text') fullText += part.text || '';
        }
        if (fullText) events.push({ type: 'agent_message', runId, text: fullText });
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
                }
            }
        }
        const finished = info.finish === 'stop' || info.finish === 'end';
        return { runId, events, nextText: fullText, finished };
    }

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
        });
    }

    return { runId, events };
}
