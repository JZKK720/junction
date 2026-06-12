import * as http from 'http';
import * as https from 'https';

export interface JsonRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface SseEvent {
    event: string;
    data: string;
}

export function jsonRequest<T = any>(url: string, opts: JsonRequestOptions = {}): Promise<T> {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() } : {}),
        ...(opts.headers ?? {}),
    };

    return new Promise<T>((resolve, reject) => {
        const req = lib.request(parsed, { method: opts.method ?? (body ? 'POST' : 'GET'), headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                if ((res.statusCode ?? 500) >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
                    return;
                }
                if (!text.trim()) {
                    resolve(undefined as T);
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeoutMs ?? 30000, () => req.destroy(new Error(`HTTP request timed out: ${url}`)));
        if (body) req.write(body);
        req.end();
    });
}

export function textRequest(url: string, opts: JsonRequestOptions = {}): Promise<string> {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    return new Promise<string>((resolve, reject) => {
        const req = lib.request(parsed, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                if ((res.statusCode ?? 500) >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
                    return;
                }
                resolve(text);
            });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeoutMs ?? 30000, () => req.destroy(new Error(`HTTP request timed out: ${url}`)));
        req.end();
    });
}

export function streamSse(
    url: string,
    opts: JsonRequestOptions,
    onEvent: (event: SseEvent) => void,
): Promise<void> {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
        accept: 'text/event-stream',
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() } : {}),
        ...(opts.headers ?? {}),
    };

    return new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) {
            resolve();
            return;
        }

        const req = lib.request(parsed, { method: opts.method ?? 'POST', headers }, (res) => {
            if ((res.statusCode ?? 500) >= 400) {
                let errText = '';
                res.on('data', (chunk) => { errText += chunk.toString(); });
                res.on('end', () => reject(new Error(`SSE HTTP ${res.statusCode}: ${errText.slice(0, 300)}`)));
                return;
            }

            let buffer = '';
            let eventName = 'message';
            let dataLines: string[] = [];
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buffer += chunk;
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line) {
                        if (dataLines.length) {
                            onEvent({ event: eventName, data: dataLines.join('\n') });
                            eventName = 'message';
                            dataLines = [];
                        }
                        continue;
                    }
                    if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
                    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
                }
            });
            res.on('end', () => {
                if (dataLines.length) onEvent({ event: eventName, data: dataLines.join('\n') });
                resolve();
            });
        });

        if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
                req.destroy();
                resolve();
            });
        }

        req.on('error', (err) => {
            if (opts.signal?.aborted) {
                resolve();
            } else {
                reject(err);
            }
        });
        req.setTimeout(opts.timeoutMs ?? 0, () => req.destroy(new Error(`SSE timed out: ${url}`)));
        if (body) req.write(body);
        req.end();
    });
}
