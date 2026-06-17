import { MappedBridgeEvent } from '../types';

/**
 * OpenHands (agent-sdk) events are polled from
 * GET /api/v1/conversation/{id}/events/search and come back as a heterogenous
 * union keyed by `kind` (MESSAGE / ACTION / OBSERVATION / …). The exact field
 * layout varies by SDK version, so extraction here is intentionally defensive:
 * we read text/thought/tool data from the common locations and degrade quietly.
 */
export interface OpenHandsMapped {
    /** Assistant message text for this event (a full chunk, not a delta). */
    assistantText?: string;
    /** Reasoning / thought text. */
    thinking?: string;
    /** Tool start/result bridge events. */
    tools: MappedBridgeEvent[];
    /** True when this event marks the agent going idle / awaiting the user. */
    finished?: boolean;
}

function asText(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(asText).join('');
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
        if (Array.isArray(value.content)) return value.content.map(asText).join('');
    }
    return '';
}

export function mapOpenHandsEvent(runId: string, e: any): OpenHandsMapped {
    const out: OpenHandsMapped = { tools: [] };
    if (!e || typeof e !== 'object') return out;

    const kind = String(e.kind || e.action || e.type || '').toLowerCase();
    const msg = e.llm_message || e.message || {};
    const role = String(msg.role || e.source || '').toLowerCase();

    // Agent state going idle / finished / awaiting user.
    const state = String(e.agent_state || e.state || (kind.includes('state') ? asText(e.content) : '')).toLowerCase();
    if (state.includes('idle') || state.includes('finished') || state.includes('awaiting') || state.includes('await_user')) {
        out.finished = true;
    }

    // Reasoning / thought.
    const thought = asText(e.thought ?? e.reasoning);
    if (thought) out.thinking = thought;

    // Tool action (agent invoking a tool / command).
    const toolName = e.tool_name || e.tool || e.command || (kind === 'action' && e.name);
    if ((kind.includes('action') || kind === 'cmd') && toolName && role !== 'user') {
        out.tools.push({
            type: 'tool_event', phase: 'start', runId,
            toolCallId: String(e.tool_call_id || e.id || `oh-${Math.random().toString(36).slice(2, 8)}`),
            toolName: String(toolName),
            args: e.arguments || e.args || {},
        });
    }

    // Tool observation (result of a tool/command).
    if (kind.includes('observation')) {
        out.tools.push({
            type: 'tool_event', phase: 'result', runId,
            toolCallId: String(e.tool_call_id || e.cause || e.id || ''),
            result: asText(e.content ?? e.observation ?? e.message),
            isError: !!e.error || /error/i.test(kind),
        });
        return out;
    }

    // Assistant message text (skip user echoes and pure tool events).
    const text = asText(e.content ?? msg.content ?? e.message ?? e.text);
    if (text && role !== 'user') out.assistantText = text;

    return out;
}
