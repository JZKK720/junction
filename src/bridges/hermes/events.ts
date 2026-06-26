import { MappedBridgeEvent, EventMappingResult } from '../types';

// AUDIT (2026-06-26): Every event path in this normalizer spreads `base`, which
// always contains sessionKey. No code path can produce an event without it.
// The Hermes bridge's mapEvent() derives sessionId from the gateway's session_id
// via sessionKeyByLive lookup — verified against tui_gateway/server.py _emit().
export function mapHermesWsEvent(ev: any, _activeSessionId: string | null, previousText = ''): EventMappingResult {
    // AUDIT: The old `activeSessionId` fallback was removed — it mirrored the
    // pattern that caused the session-bleed bug in chatBase.ts (using a shared
    // mutable that may belong to a different view).  mapEvent() always stamps
    // ev.session_id before calling us; the fallback was dead code that would
    // have produced wrong-session events if this function were ever called
    // directly.  'hermes' is a sentinel that won't match any viewSessionKey
    // (events get dropped silently, not bled to the wrong window).
    const sessionId = ev?.session_id || 'hermes';
    const payload = ev?.payload || {};
    const events: MappedBridgeEvent[] = [];
    const base = { sessionKey: sessionId, runId: sessionId };

    if (ev?.type === 'message.start') {
        events.push({ type: 'agent_lifecycle', phase: 'start', ...base });
    } else if (ev?.type === 'message.delta') {
        const delta = payload.delta || payload.text || '';
        const fullText = previousText + delta;
        events.push({ type: 'agent_message', ...base, text: fullText, delta });
        return { runId: sessionId, events, nextText: fullText };
    } else if (ev?.type === 'message.complete') {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text && text !== previousText) {
            events.push({ type: 'agent_message', ...base, text, delta: text.slice(previousText.length) });
        }
        events.push({ type: 'agent_lifecycle', phase: 'completed', ...base, usage: normalizeHermesUsage(payload.usage) });
        return { runId: sessionId, events, clearBuffer: true };
    } else if (ev?.type === 'thinking.delta' || ev?.type === 'reasoning.delta') {
        events.push({ type: 'thinking_chunk', ...base, text: payload.text || payload.delta || '' });
    } else if (ev?.type === 'tool.start') {
        const id = toolId(payload);
        const args = toolArgs(payload);
        if (!id && !hasUsefulValue(args)) return { runId: sessionId, events };
        events.push({
            type: 'tool_event',
            phase: 'start',
            ...base,
            toolCallId: id,
            toolName: payload.name || payload.tool_name,
            args,
        });
    } else if (ev?.type === 'tool.generating') {
        // Hermes' mid-tool progress event (the gateway never emits tool.progress
        // / tool.update — those were dead branches).
        const text = payload.text || payload.delta || payload.preview || payload.summary || '';
        if (!toolId(payload) && !hasUsefulValue(text)) return { runId: sessionId, events };
        events.push({ type: 'tool_event', phase: 'update', ...base, toolCallId: toolId(payload), toolName: payload.name || payload.tool_name, result: text });
    } else if (ev?.type === 'tool.complete') {
        events.push({
            type: 'tool_event',
            phase: 'result',
            ...base,
            toolCallId: toolId(payload),
            toolName: payload.name || payload.tool_name,
            args: payload.args || payload.context || {},
            result: payload.inline_diff || payload.result_text || payload.result || payload.text || payload.summary || '',
            isError: !!payload.error,
        });
    } else if (ev?.type === 'approval.request') {
        // Gateway is blocking the agent thread waiting for an approval choice.
        // Resolved via approval.respond (keyed by session_id, not request_id).
        events.push({
            type: 'approval_request',
            ...base,
            requestId: String(payload.request_id ?? payload.pattern_key ?? sessionId),
            kind: String(payload.kind ?? payload.surface ?? 'exec'),
            toolName: payload.tool ?? payload.name ?? payload.tool_name,
            command: payload.command ?? '',
            description: payload.description ?? '',
            patternKey: payload.pattern_key ?? '',
            paths: payload.paths ?? payload.fileSystem ?? undefined,
            network: payload.network ?? undefined,
            // Gateway downgrades "always" to session scope when a Tirith warning
            // fires (allow_permanent:false) — the UI must not offer permanent allow.
            allowPermanent: payload.allow_permanent !== false,
        });
    } else if (ev?.type === 'secret.request' || ev?.type === 'sudo.request'
        || ev?.type === 'clarify.request' || ev?.type === 'terminal.read.request') {
        // Blocking input prompts (each resolved by its own *.respond RPC, keyed
        // by request_id). `kind` selects the RPC + response field downstream.
        const kind = ev.type.replace(/\.request$/, '');
        events.push({
            type: 'input_request',
            ...base,
            requestId: String(payload.request_id ?? ''),
            kind,
            prompt: payload.prompt ?? payload.message ?? payload.description ?? '',
            secret: kind === 'secret' || kind === 'sudo',
        });
    } else if (ev?.type === 'session.info') {
        // Gateway-pushed session metadata (model/title/usage). Consumed by the
        // bridge to sync knownSessions; not rendered directly.
        events.push({
            type: 'session_meta',
            ...base,
            model: payload.model,
            title: payload.title,
            usage: normalizeHermesUsage(payload.usage),
        });
    } else if (ev?.type === 'status.update') {
        events.push({ type: 'status', ...base, kind: String(payload.kind ?? 'status'), text: payload.text ?? '' });
    } else if (ev?.type === 'error') {
        events.push({ type: 'agent_lifecycle', phase: 'error', ...base });
    }

    return { runId: sessionId, events };
}

function toolId(payload: any): string {
    return String(payload?.tool_id ?? payload?.toolCallId ?? payload?.tool_call_id ?? payload?.id ?? '');
}

function toolArgs(payload: any): any {
    return payload?.args ?? payload?.context ?? payload?.args_text ?? payload?.preview ?? undefined;
}

function hasUsefulValue(value: any): boolean {
    if (value == null) return false;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return !!trimmed && trimmed !== '{}' && trimmed !== 'undefined';
    }
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function normalizeHermesUsage(usage: any): { inputTokens?: number; outputTokens?: number } | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const inputTokens = numberOrUndefined(usage.input ?? usage.prompt ?? usage.input_tokens ?? usage.prompt_tokens);
    const outputTokens = numberOrUndefined(usage.output ?? usage.completion ?? usage.output_tokens ?? usage.completion_tokens);
    return inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens } : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
