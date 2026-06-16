import { MappedBridgeEvent } from '../types';

/**
 * Extract thinking_chunk events from a session.message payload.
 *
 * The OpenClaw gateway embeds thinking blocks inside the message.content
 * array as `{ type: 'thinking', thinking: '...' }` objects.  Other event
 * types (agent_message, chat_message) carry the visible text separately,
 * so we only emit thinking_chunk here — no text duplication.
 */
export function extractThinkingFromSessionMessage(payload: any): MappedBridgeEvent[] {
    const events: MappedBridgeEvent[] = [];
    const msg = payload?.message;
    if (!msg || !Array.isArray(msg.content)) return events;

    const sessionKey: string = payload.sessionKey || '';
    for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking) {
            events.push({
                type: 'thinking_chunk',
                text: part.thinking,
                sessionKey,
            });
        }
    }
    return events;
}
