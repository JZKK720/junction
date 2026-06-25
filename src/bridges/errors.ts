export type NormalizedBridgeErrorKind = 'busy' | 'not_found' | 'disconnected' | 'timeout' | 'cancelled' | 'unknown';

export interface NormalizedBridgeError {
    kind: NormalizedBridgeErrorKind;
    message: string;
}

export function normalizeBridgeError(error: unknown): NormalizedBridgeError {
    const raw = String((error as any)?.message ?? error ?? '').trim() || 'Bridge request failed';
    const lower = raw.toLowerCase();
    if (/session (?:is )?busy|busy/.test(lower)) return { kind: 'busy', message: 'Session busy. Wait for current run to finish or stop it.' };
    if (/session not found|not found/.test(lower)) return { kind: 'not_found', message: 'Session not found. Resume or start a new chat.' };
    if (/disconnect|closed|not open|not connected/.test(lower)) return { kind: 'disconnected', message: 'Bridge disconnected. Reconnect runtime and retry.' };
    if (/timed? ?out|timeout/.test(lower)) return { kind: 'timeout', message: 'Bridge request timed out.' };
    if (/cancelled|canceled|aborted|abort/.test(lower)) return { kind: 'cancelled', message: 'Run cancelled.' };
    return { kind: 'unknown', message: raw };
}
