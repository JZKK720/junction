import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export class Logger {
    private static instance: Logger;
    private ch: vscode.LogOutputChannel;

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

    // No-op: LogOutputChannel handles its own file logging via VS Code's log infrastructure
    public enableFileLogging(_context: vscode.ExtensionContext): void {}

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
}
