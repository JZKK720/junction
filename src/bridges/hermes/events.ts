export interface MappedBridgeEvent {
    type: string;
    [key: string]: unknown;
}

export interface HermesEventMapping {
    runId: string;
    events: MappedBridgeEvent[];
    nextText?: string;
    clearBuffer?: boolean;
}

export function mapHermesWsEvent(ev: any, activeSessionId: string | null, previousText = ''): HermesEventMapping {
    const sessionId = ev?.session_id || activeSessionId || 'hermes';
    const payload = ev?.payload || {};
    const events: MappedBridgeEvent[] = [];

    if (ev?.type === 'message.start') {
        events.push({ type: 'agent_lifecycle', phase: 'start', runId: sessionId });
    } else if (ev?.type === 'message.delta') {
        const delta = payload.delta || payload.text || '';
        const fullText = previousText + delta;
        events.push({ type: 'agent_message', runId: sessionId, text: fullText, delta });
        return { runId: sessionId, events, nextText: fullText };
    } else if (ev?.type === 'message.complete') {
        events.push({ type: 'agent_lifecycle', phase: 'completed', runId: sessionId });
        return { runId: sessionId, events, clearBuffer: true };
    } else if (ev?.type === 'thinking.delta' || ev?.type === 'reasoning.delta') {
        events.push({ type: 'thinking_chunk', runId: sessionId, text: payload.text || payload.delta || '' });
    } else if (ev?.type === 'tool.start') {
        events.push({ type: 'tool_event', phase: 'start', runId: sessionId, toolCallId: payload.id, toolName: payload.name, args: payload.args || {} });
    } else if (ev?.type === 'tool.progress') {
        events.push({ type: 'tool_event', phase: 'update', runId: sessionId, toolCallId: payload.id, result: payload.text || payload.delta || '' });
    } else if (ev?.type === 'tool.complete') {
        events.push({
            type: 'tool_event',
            phase: 'result',
            runId: sessionId,
            toolCallId: payload.id,
            toolName: payload.name,
            result: payload.result || payload.text || '',
            isError: !!payload.error,
        });
    } else if (ev?.type === 'error') {
        events.push({ type: 'agent_lifecycle', phase: 'error', runId: sessionId });
    }

    return { runId: sessionId, events };
}
