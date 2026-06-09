import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface ChatIndexRecord {
    sessionKey: string;
    bindingId: string;
    bindingLabel: string;
    summary?: string;
    model?: string;
    lastActiveTs: number;
    gatewayUrl: string;
}

const KEY = 'junction.chatIndex';

export class ChatIndex {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly gatewayUrl: () => string,
    ) {}

    upsert(record: Omit<ChatIndexRecord, 'gatewayUrl' | 'lastActiveTs'> & { lastActiveTs?: number }): void {
        const all = this.load();
        all[record.sessionKey] = {
            ...record,
            gatewayUrl: this.gatewayUrl(),
            lastActiveTs: record.lastActiveTs ?? Date.now(),
        };
        void this.context.globalState.update(KEY, all);
    }

    forBinding(bindingId: string): ChatIndexRecord[] {
        return this.all().filter((item) => item.bindingId === bindingId);
    }

    all(): ChatIndexRecord[] {
        const gatewayUrl = this.gatewayUrl();
        return Object.values(this.load()).filter((item) => item.gatewayUrl === gatewayUrl);
    }

    prune(liveKeys: Set<string>): void {
        const all = this.load();
        let changed = false;
        for (const [key, record] of Object.entries(all)) {
            if (record.gatewayUrl === this.gatewayUrl() && !liveKeys.has(key)) {
                delete all[key];
                changed = true;
            }
        }
        if (changed) void this.context.globalState.update(KEY, all);
    }

    private load(): Record<string, ChatIndexRecord> {
        return this.context.globalState.get<Record<string, ChatIndexRecord>>(KEY, {});
    }
}

export function bindingIdForUri(uri: vscode.Uri): string {
    return crypto.createHash('sha256').update(uri.toString()).digest('hex').slice(0, 16);
}
