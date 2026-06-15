import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export class Logger {
    private static instance: Logger;
    private ch: vscode.LogOutputChannel;
    private debugDir: string | null = null;

    private constructor() {
        if (!channel) {
            channel = vscode.window.createOutputChannel('Junction', { log: true });
        }
        this.ch = channel;
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public enableFileLogging(context: vscode.ExtensionContext): void {
        try {
            const dir = path.join(context.globalStorageUri.fsPath, 'debug-captures');
            fs.mkdirSync(dir, { recursive: true });
            this.debugDir = dir;
            this.info('Debug capture dir ready', { dir });
        } catch (error) {
            this.error('Failed to initialize debug capture dir', error);
        }
    }

    // Legacy shim kept so showLogs command continues to work
    public getLogFilePath(): string | undefined { return undefined; }

    public debug(message: string, data?: any): void {
        this.ch.debug(data !== undefined ? `${message} ${JSON.stringify(data)}` : message);
    }

    public info(message: string, data?: any): void {
        this.ch.info(data !== undefined ? `${message} ${JSON.stringify(data)}` : message);
    }

    public warn(message: string, data?: any): void {
        this.ch.warn(data !== undefined ? `${message} ${JSON.stringify(data)}` : message);
    }

    public error(message: string, error?: any): void {
        if (error instanceof Error) {
            this.ch.error(`${message}: ${error.message}\n${error.stack ?? ''}`);
        } else {
            this.ch.error(error !== undefined ? `${message} ${JSON.stringify(error)}` : message);
        }
    }

    public show(): void { this.ch.show(); }

    public logWebSocketTraffic(direction: 'SEND' | 'RECEIVE', data: any): void {
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        this.debug(`WebSocket ${direction}: ${str.substring(0, 1000)}${str.length > 1000 ? '...' : ''}`);
    }

    public captureDebugStream(kind: string, payload: any): void {
        if (!this.debugDir) return;
        const file = path.join(this.debugDir, `${kind}.jsonl`);
        const entry = {
            ts: new Date().toISOString(),
            kind,
            payload: this.toSerializable(payload),
        };
        void fs.promises.appendFile(file, JSON.stringify(entry) + '\n', 'utf8').catch((error) => {
            this.error(`Failed writing debug capture ${kind}`, error);
        });
    }

    private toSerializable(value: any, depth = 0, seen = new WeakSet<object>()): any {
        if (value === null || value === undefined) return value;
        if (depth > 6) return '[TruncatedDepth]';
        if (typeof value === 'string') return value.length > 20000 ? value.slice(0, 20000) + '\n[TruncatedString]' : value;
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof Error) {
            return { name: value.name, message: value.message, stack: value.stack };
        }
        if (Array.isArray(value)) {
            return value.slice(0, 200).map((item) => this.toSerializable(item, depth + 1, seen));
        }
        if (typeof value === 'object') {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
            const out: Record<string, any> = {};
            for (const [key, entry] of Object.entries(value).slice(0, 200)) {
                out[key] = this.toSerializable(entry, depth + 1, seen);
            }
            return out;
        }
        return String(value);
    }
}
