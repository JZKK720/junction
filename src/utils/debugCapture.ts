import { Logger } from './logger';

export type BridgeDebugKind =
    | 'request'
    | 'native'
    | 'normalized'
    | 'history-native'
    | 'history-normalized';

const SCHEMA_VERSION = 1;
const MAX_DEPTH = 8;
const MAX_STRING = 20_000;
const MAX_ARRAY = 200;
const MAX_KEYS = 200;
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization|cookie|credential|refresh|bearer)/i;
const SAFE_KEY_RE = /^(sessionKey|bridgeId|runId|modelId)$/;

export function debugStreamName(bridgeId: string, kind: BridgeDebugKind | 'render-mode-state'): string {
    if (kind === 'render-mode-state') return 'render-mode-state';
    return `bridge-${sanitizeDebugPart(bridgeId)}-${kind}`;
}

export function newDebugRunId(bridgeId: string, operation: string): string {
    return `${sanitizeDebugPart(bridgeId)}:${sanitizeDebugPart(operation)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function redactDebugPayload(payload: any): any {
    return redactValue(payload, 0, new WeakSet<object>(), '');
}

export function captureBridgeDebug(bridgeId: string, kind: Exclude<BridgeDebugKind, 'history-native' | 'history-normalized'>, payload: any): void {
    captureBridgeEntry(bridgeId, kind, payload);
}

export function captureBridgeHistoryDebug(bridgeId: string, kind: 'history-native' | 'history-normalized', payload: any): void {
    captureBridgeEntry(bridgeId, kind, payload);
}

export function captureRenderDebug(kind: string, payload: any): void {
    Logger.getInstance().captureDebugStream('render-mode-state', {
        schemaVersion: SCHEMA_VERSION,
        kind: 'render',
        operation: kind,
        payload: redactDebugPayload(payload),
    });
}

function captureBridgeEntry(bridgeId: string, kind: BridgeDebugKind, payload: any): void {
    const safe = redactDebugPayload(payload);
    Logger.getInstance().captureDebugStream(debugStreamName(bridgeId, kind), {
        schemaVersion: SCHEMA_VERSION,
        bridgeId,
        kind,
        operation: safe?.operation,
        sessionKey: safe?.sessionKey,
        runId: safe?.runId,
        correlationId: safe?.correlationId,
        eventType: safe?.eventType ?? safe?.type,
        payload: safe,
    });
}

function sanitizeDebugPart(value: string): string {
    return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function redactValue(value: any, depth: number, seen: WeakSet<object>, key: string): any {
    if (key && SECRET_KEY_RE.test(key) && !SAFE_KEY_RE.test(key)) return '[REDACTED]';
    if (value === null || value === undefined) return value;
    if (depth > MAX_DEPTH) return '[TruncatedDepth]';
    if (typeof value === 'string') {
        return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '\n[TruncatedString]' : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((entry) => redactValue(entry, depth + 1, seen, ''));
    if (typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        const out: Record<string, any> = {};
        for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_KEYS)) {
            out[entryKey] = redactValue(entryValue, depth + 1, seen, entryKey);
        }
        return out;
    }
    return String(value);
}
