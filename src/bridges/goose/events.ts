import { EventMappingResult, MappedBridgeEvent } from '../types';

export interface GooseMapperState {
    text: string;
    thinking: string;
    pendingTools: Map<string, { name: string; args: any }>;
}

export function createGooseMapperState(): GooseMapperState {
    return { text: '', thinking: '', pendingTools: new Map() };
}

export function mapGooseStreamJsonLine(
    runId: string,
    line: string,
    state: GooseMapperState,
): EventMappingResult {
    let payload: any;
    try { payload = JSON.parse(line); } catch { return { runId, events: [] }; }

    const events: MappedBridgeEvent[] = [];
    if (payload?.type === 'complete') {
        events.push({
            type: 'agent_lifecycle',
            phase: 'completed',
            runId,
            usage: {
                inputTokens: numberOrUndefined(payload.input_tokens),
                outputTokens: numberOrUndefined(payload.output_tokens),
            },
        });
        return { runId, events, finished: true };
    }

    if (payload?.type !== 'message') return { runId, events };
    const message = payload.message ?? {};
    const role = String(message.role ?? '');
    const content = Array.isArray(message.content) ? message.content : [];

    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'thinking') {
            const normalized = normalizeThinkingText(part.thinking ?? part.text ?? '');
            const text = joinThinkingDelta(state.thinking, normalized);
            if (text) events.push({ type: 'thinking_chunk', runId, text });
            state.thinking += text;
            continue;
        }
        if (role === 'assistant' && part.type === 'text') {
            const delta = String(part.text ?? '');
            if (!delta) continue;
            state.text += delta;
            events.push({ type: 'agent_message', runId, text: state.text, delta });
            continue;
        }
        if (role === 'assistant' && part.type === 'toolRequest') {
            const id = String(part.id ?? part.toolCallId ?? `goose-tool-${state.pendingTools.size}`);
            const call = part.toolCall?.value ?? part.toolCall ?? {};
            const toolName = String(call.name ?? part.name ?? 'tool');
            const args = call.arguments ?? part.arguments ?? {};
            state.pendingTools.set(id, { name: toolName, args });
            events.push({ type: 'tool_event', phase: 'start', runId, toolCallId: id, toolName, args });
            continue;
        }
        if (role === 'user' && part.type === 'toolResponse') {
            const id = String(part.id ?? part.toolCallId ?? '');
            const known = id ? state.pendingTools.get(id) : undefined;
            const result = part.toolResult?.value ?? part.toolResult ?? part.result ?? '';
            const resultObject = result && typeof result === 'object' ? result as any : undefined;
            const isError = !!(part.toolResult?.isError ?? resultObject?.isError ?? part.isError);
            events.push({
                type: 'tool_event',
                phase: 'result',
                runId,
                toolCallId: id,
                toolName: known?.name,
                args: known?.args,
                result,
                isError,
            });
        }
    }

    return { runId, events };
}

function numberOrUndefined(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function normalizeThinkingText(value: unknown): string {
    return String(value ?? '')
        .replace(/\s*\r?\n\s*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function joinThinkingDelta(previous: string, next: string): string {
    if (!previous || !next) return next;
    if (/[A-Za-z0-9)'"`”’\]]$/.test(previous) && /^[A-Za-z0-9('"`“‘\[]/.test(next)) {
        return ` ${next}`;
    }
    return next;
}
