import { Logger } from '../utils/logger';
import type { ChatBridge } from '../bridges/types';

export type HistoryLoadSource = 'chat.history' | 'jsonl-fallback' | 'none';

export interface LoadedHistoryMessages {
    messages: any[];
    source: HistoryLoadSource;
}

export function extractHistoryMessages(history: any): any[] {
    if (Array.isArray(history)) return history;
    if (Array.isArray(history?.messages)) return history.messages;
    if (Array.isArray(history?.payload?.messages)) return history.payload.messages;
    return [];
}

export async function loadHistoryMessages(bridge: ChatBridge, limit: number): Promise<LoadedHistoryMessages> {
    const history = await bridge.getSessionHistory(limit);
    const messages = extractHistoryMessages(history);
    if (messages.length > 0) return { messages, source: 'chat.history' };

    return loadJsonlFallback(bridge, limit);
}

async function loadJsonlFallback(bridge: ChatBridge, limit: number): Promise<LoadedHistoryMessages> {
    const jsonlReader = (bridge as any).getSessionHistoryFromJsonl;
    const sessionKey = bridge.getCurrentSessionKey();
    if (typeof jsonlReader !== 'function' || !sessionKey) {
        return { messages: [], source: 'none' };
    }

    try {
        const jsonl = await jsonlReader.call(bridge, sessionKey, 0, 512 * 1024);
        const messages = extractHistoryMessages(jsonl);
        if (messages.length > 0) {
            Logger.getInstance().info('Falling back to JSONL history restore', {
                sessionKey,
                limit,
                recovered: messages.length,
            });
            return { messages, source: 'jsonl-fallback' };
        }
    } catch (error) {
        Logger.getInstance().warn('JSONL history fallback failed', error);
    }

    return { messages: [], source: 'none' };
}
