import * as vscode from 'vscode';
import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';

/**
 * ApprovalRelay — surfaces OpenClaw exec/plugin approval prompts through the
 * shared inline approval UX (the `approval_request` stream event consumed by
 * chatBase → render/approvals.js), falling back to a native modal for prompts
 * on sessions no view is currently watching so they never silently hang.
 *
 * Extracted from MessageProcessor so the approval transport is one reusable,
 * testable unit instead of inline handlers on a singleton.
 *
 * Gateway contract (see ~/sauce/openclaw-src/src/acp/translator.ts):
 *   event  exec.approval.requested   { requestId, command?, sessionKey? }
 *   event  plugin.approval.requested { requestId, pluginId?, sessionKey? }
 *   call   exec.approval.get   { id }  → { commandText?, commandPreview?, allowedDecisions?, host? }
 *   call   exec.approval.resolve   { id, decision }
 *   call   plugin.approval.resolve { id, decision }
 *   call   exec.approval.list  → pending approvals (reconnect recovery)
 * Decisions: allow-once | allow-session | allow-always | deny.
 */

type OpenClawDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';
type ApprovalKind = 'exec' | 'plugin';

interface PendingApproval {
    requestId: string;
    kind: ApprovalKind;
    sessionKey?: string;
    inline: boolean;
}

const NEUTRAL_BY_DECISION: Record<OpenClawDecision, { choice: string; label: string }> = {
    'allow-once': { choice: 'once', label: 'Allow once' },
    'allow-session': { choice: 'session', label: 'Allow for session' },
    'allow-always': { choice: 'always', label: 'Always allow' },
    'deny': { choice: 'deny', label: 'Deny' },
};

const DECISION_BY_NEUTRAL: Record<string, OpenClawDecision> = {
    once: 'allow-once',
    session: 'allow-session',
    always: 'allow-always',
    deny: 'deny',
};

export class ApprovalRelay {
    private readonly pending = new Map<string, PendingApproval>();
    private readonly resolved = new Set<string>();

    constructor(
        private readonly gateway: GatewayConnection,
        private readonly emitStream: (event: any) => void,
    ) {
        this.gateway.on('exec.approval.requested', (payload: any) => {
            void this.onApprovalRequested('exec', payload);
        });
        this.gateway.on('plugin.approval.requested', (payload: any) => {
            void this.onApprovalRequested('plugin', payload);
        });
    }

    /** Map the inline UI's neutral choice back to the gateway decision vocab and resolve. */
    async respond(requestId: string, choice: string): Promise<void> {
        const entry = this.pending.get(requestId);
        const decision = DECISION_BY_NEUTRAL[choice] ?? 'deny';
        await this.resolve(requestId, decision, entry?.kind ?? 'exec');
    }

    /** Re-fetch still-pending approvals after a reconnect so they re-surface. */
    async recoverPending(): Promise<void> {
        if (!this.gateway.authScopes?.includes('operator.approvals')) return;
        try {
            const res = await this.gateway.sendRequest('exec.approval.list', {});
            const rows = Array.isArray(res?.approvals) ? res.approvals : (Array.isArray(res) ? res : []);
            for (const row of rows) {
                const requestId = String(row?.requestId ?? row?.id ?? '');
                if (!requestId || this.pending.has(requestId) || this.resolved.has(requestId)) continue;
                await this.onApprovalRequested('exec', { ...row, requestId });
            }
        } catch (err) {
            Logger.getInstance().warn('exec.approval.list recovery failed', err);
        }
    }

    private async onApprovalRequested(kind: ApprovalKind, payload: any): Promise<void> {
        if (!this.gateway.authScopes?.includes('operator.approvals')) {
            Logger.getInstance().warn(`${kind}.approval.requested: missing operator.approvals scope`);
            return;
        }
        const requestId = String(
            payload?.requestId ?? payload?.request?.requestId ?? payload?.approvalId ?? payload?.id ?? '',
        );
        if (!requestId || this.resolved.has(requestId) || this.pending.has(requestId)) return;
        const sessionKey = optionalString(payload?.sessionKey ?? payload?.request?.sessionKey);

        let command = optionalString(payload?.command ?? payload?.request?.command) ?? '';
        let options = defaultOptionsFor(kind);
        if (kind === 'exec') {
            const details = await this.hydrate(requestId);
            command = optionalString(details?.commandText ?? details?.commandPreview) ?? command;
            const allowed = normalizeDecisions(details?.allowedDecisions);
            if (allowed.length) options = allowed.map((d) => NEUTRAL_BY_DECISION[d]);
        }
        const pluginId = optionalString(payload?.pluginId ?? payload?.request?.pluginId);

        // Inline when a view is watching the session; otherwise native modal so
        // background-session approvals never hang on the gateway timeout.
        const inline = !!sessionKey && this.gateway.isWatchedSession(sessionKey);
        this.pending.set(requestId, { requestId, kind, sessionKey, inline });

        if (inline) {
            this.emitStream({
                type: 'approval_request',
                sessionKey,
                runId: sessionKey,
                requestId,
                kind,
                toolName: kind === 'plugin' ? (pluginId || 'plugin') : 'exec',
                command,
                description: kind === 'plugin' ? `Plugin ${pluginId ?? ''}`.trim() : '',
                options,
                allowPermanent: options.some((o) => o.choice === 'always'),
            });
            return;
        }
        await this.promptNative(requestId, kind, command, pluginId, options);
    }

    private async promptNative(
        requestId: string,
        kind: ApprovalKind,
        command: string,
        pluginId: string | undefined,
        options: Array<{ choice: string; label: string }>,
    ): Promise<void> {
        const subject = kind === 'plugin'
            ? `plugin approval: ${pluginId || 'unknown plugin'}`
            : `exec approval: ${command.length > 80 ? command.slice(0, 80) + '…' : (command || 'unknown command')}`;
        const labels = options.filter((o) => o.choice !== 'deny').map((o) => o.label);
        const picked = await vscode.window.showWarningMessage(
            `OpenClaw ${subject}`,
            { modal: true },
            ...labels,
            'Deny',
        );
        const chosen = options.find((o) => o.label === picked);
        await this.respond(requestId, chosen?.choice ?? 'deny');
    }

    private async hydrate(requestId: string): Promise<any | null> {
        try {
            return await this.gateway.sendRequest('exec.approval.get', { id: requestId });
        } catch (err) {
            Logger.getInstance().warn('exec.approval.get hydrate failed', err);
            return null;
        }
    }

    private async resolve(requestId: string, decision: OpenClawDecision, kind: ApprovalKind): Promise<void> {
        if (this.resolved.has(requestId)) return;
        this.resolved.add(requestId);
        this.pending.delete(requestId);
        const method = kind === 'plugin' ? 'plugin.approval.resolve' : 'exec.approval.resolve';
        try {
            await this.gateway.sendRequest(method, { id: requestId, decision });
        } catch (err) {
            Logger.getInstance().error(`${method} failed`, err);
        }
    }
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeDecisions(value: unknown): OpenClawDecision[] {
    if (!Array.isArray(value)) return [];
    const order: OpenClawDecision[] = ['allow-once', 'allow-session', 'allow-always', 'deny'];
    const set = new Set(value.filter((v): v is OpenClawDecision => v === 'allow-once' || v === 'allow-session' || v === 'allow-always' || v === 'deny'));
    return order.filter((d) => set.has(d));
}

function defaultOptionsFor(kind: ApprovalKind): Array<{ choice: string; label: string }> {
    // Conservative defaults when the gateway doesn't advertise allowedDecisions.
    const decisions: OpenClawDecision[] = kind === 'plugin'
        ? ['allow-once', 'allow-always', 'deny']
        : ['allow-once', 'allow-session', 'allow-always', 'deny'];
    return decisions.map((d) => NEUTRAL_BY_DECISION[d]);
}
