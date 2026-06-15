import { MappedBridgeEvent, EventMappingResult } from '../types';

export function mapSouveraineSseEvent(runId: string, eventName: string, data: string, previousText = ''): EventMappingResult {
    let payload: any = {};
    try { payload = JSON.parse(data); } catch {}

    const events: MappedBridgeEvent[] = [];
    if (eventName === 'message' || payload.message_type === 'assistant_message') {
        const delta = payload.content || data;
        const fullText = previousText + delta;
        events.push({ type: 'agent_message', runId, text: fullText, delta });
        return { runId, events, nextText: fullText };
    }

    if (eventName === 'reasoning' || payload.message_type === 'reasoning_message') {
        events.push({ type: 'thinking_chunk', runId, text: payload.content || data });
    } else if (eventName === 'tool_call') {
        events.push({
            type: 'tool_event',
            phase: 'start',
            runId,
            toolCallId: payload.tool_call?.id,
            toolName: payload.tool_call?.function?.name,
            args: payload.tool_call?.function?.arguments || {},
        });
    } else if (eventName === 'tool_return') {
        events.push({
            type: 'tool_event',
            phase: 'result',
            runId,
            toolCallId: payload.tool_return?.id,
            result: payload.tool_return?.output || '',
            isError: payload.tool_return?.status === 'error',
        });
    } else if (eventName.startsWith('souveraine_')) {
        const text = payload.content || payload.synthesis || data;
        events.push({ type: 'thinking_chunk', runId, text: `\n[${eventName}] ${text}` });
    }

    return { runId, events };
}
