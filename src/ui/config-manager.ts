/**
 * ConfigManager — handles VS Code configuration for the Junction chat UI.
 *
 * Responsible for:
 * - Reading/writing extension settings (sendBehavior, reasoningDisplay, etc.)
 * - Reading/writing animation settings (globalState)
 * - Building config payloads to send to the webview
 * - Sandbox/approval mode configuration UI
 *
 * Extracted from chatBase.ts.
 */

import * as vscode from 'vscode';
import { config } from '../config/agentBridgeConfig';
import { ChoiceMenuItem } from '../bridges/types';
import type { WebviewConfigPayload } from './chatTypes';

export class ConfigManager {
    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Resolve the composer send-behavior mode from settings (default `enter`). */
    getSendBehavior(): 'enter' | 'ctrlEnter' | 'smartEnter' {
        const v = config().get<string>('sendBehavior', 'enter');
        return (v === 'ctrlEnter' || v === 'smartEnter') ? v : 'enter';
    }

    /** Read follow-up behavior: per-bridge setting first, then global default. */
    getFollowUpMode(bridgeId: string): 'queue' | 'steer' | 'interrupt' {
        const perBridgeKey = bridgeId ? `junction.${bridgeId}.followUpMode` : '';
        let mode = perBridgeKey ? config().get<string>(perBridgeKey, 'default') : 'default';
        if (!mode || mode === 'default') {
            mode = config().get<string>('followUpMode', 'queue');
        }
        return (mode === 'steer' || mode === 'interrupt') ? mode : 'queue';
    }

    /** Send full config to the webview. */
    buildConfigPayload(): WebviewConfigPayload {
        const reasoningDisplay = config().get<string>('reasoningDisplay', 'compact');
        const animSettings = this.context.globalState.get<any>('junction.animSettings');
        return {
            type: 'config',
            sendBehavior: this.getSendBehavior(),
            reasoningDisplay,
            extraRichText: config().get<boolean>('extraRichText', true),
            activityLayout: config().get<string>('activityStream.layout', 'accordion'),
            activityRail: config().get<boolean>('activityStream.rail', true),
            activityDots: config().get<string>('activityStream.dots', 'status'),
            showFullHistory: config().get<boolean>('showFullHistory', false),
            steerKeybinding: config().get<string>('steerKeybinding', ''),
            animConfig: animSettings?.config,
            animationMode: animSettings?.mode,
            animColor: animSettings?.color,
            loaderColor: animSettings?.loaderColor,
            splashColor: animSettings?.splashColor,
            tokenColors: this.resolveTokenColors(),
        };
    }

    /** Return explicit user token customizations; CSS falls back to VS Code theme vars. */
    resolveTokenColors(): Record<string, string> {
        const colors: Record<string, string> = {};

        const editor = vscode.workspace.getConfiguration('editor');
        const custom = editor.get<any>('tokenColorCustomizations') || {};
        const directMap: Record<string, string> = {
            comments: 'comment',
            strings: 'string',
            keywords: 'keyword',
            numbers: 'number',
            functions: 'function',
            types: 'type',
        };
        for (const [source, target] of Object.entries(directMap)) {
            const value = custom[source];
            if (typeof value === 'string' && /^#?[0-9a-f]{6,8}$/i.test(value)) {
                colors[target] = value.startsWith('#') ? value : `#${value}`;
            }
        }

        const scopeToKey = (scope: string): string | undefined => {
            if (/comment/.test(scope)) return 'comment';
            if (/string/.test(scope)) return 'string';
            if (/keyword|storage|support\.type/.test(scope)) return 'keyword';
            if (/constant\.numeric/.test(scope)) return 'number';
            if (/constant\.language|boolean/.test(scope)) return 'boolean';
            if (/entity\.name\.function|support\.function/.test(scope)) return 'function';
            if (/entity\.name\.type|entity\.name\.class|support\.class/.test(scope)) return 'type';
            return undefined;
        };
        const rules = Array.isArray(custom.textMateRules) ? custom.textMateRules : [];
        for (const rule of rules) {
            const fg = rule?.settings?.foreground;
            if (typeof fg !== 'string') continue;
            const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
            for (const raw of scopes) {
                const key = typeof raw === 'string' ? scopeToKey(raw) : undefined;
                if (key) colors[key] = fg;
            }
        }

        return colors;
    }

    /** Persist animation settings (from saveAnimConfig webview message). */
    async saveAnimConfig(data: {
        config?: any;
        mode?: string;
        color?: string;
        loaderColor?: string;
        splashColor?: string;
    }): Promise<void> {
        await this.context.globalState.update('junction.animSettings', {
            config: data.config,
            mode: data.mode,
            color: data.color,
            loaderColor: data.loaderColor,
            splashColor: data.splashColor,
        });
    }

    /** Build sandbox/approval choice items for the webview. */
    buildSandboxChoices(): ChoiceMenuItem[] {
        const sandbox = config().get<string>('sandboxMode', 'default');
        const approval = config().get<string>('approvalMode', 'default');
        return [
            { id: 'sandbox:default', label: 'Sandbox default', section: 'Sandbox', icon: 'settings', checked: sandbox === 'default', sandboxMode: 'default' as const },
            { id: 'sandbox:readonly', label: 'Read only', section: 'Sandbox', icon: 'lock', checked: sandbox === 'readonly', sandboxMode: 'readonly' as const },
            { id: 'sandbox:workspace-write', label: 'Workspace write', section: 'Sandbox', icon: 'edit', checked: sandbox === 'workspace-write', sandboxMode: 'workspace-write' as const },
            { id: 'sandbox:full-access', label: 'Full access', section: 'Sandbox', icon: 'unlock', checked: sandbox === 'full-access', sandboxMode: 'full-access' as const },
            { id: 'approval:default', label: 'Approval default', section: 'Approvals', icon: 'settings', checked: approval === 'default', approvalMode: 'default' as const },
            { id: 'approval:ask', label: 'Ask', section: 'Approvals', icon: 'question', checked: approval === 'ask', approvalMode: 'ask' as const },
            { id: 'approval:never', label: 'Never', section: 'Approvals', icon: 'check', checked: approval === 'never', approvalMode: 'never' as const },
        ];
    }

    readSandboxMode(): string {
        return config().get<string>('sandboxMode', 'default');
    }

    readApprovalMode(): string {
        return config().get<string>('approvalMode', 'default');
    }

    async updateSandboxMode(mode: string): Promise<void> {
        await config().update('sandboxMode', mode, vscode.ConfigurationTarget.Global);
    }

    async updateApprovalMode(mode: string): Promise<void> {
        await config().update('approvalMode', mode, vscode.ConfigurationTarget.Global);
    }

    /** Check if a config change event affects our settings. */
    static affectsChatConfig(e: vscode.ConfigurationChangeEvent): boolean {
        return (
            e.affectsConfiguration('junction.activityStream') ||
            e.affectsConfiguration('junction.reasoningDisplay') ||
            e.affectsConfiguration('junction.sendBehavior') ||
            e.affectsConfiguration('junction.extraRichText') ||
            e.affectsConfiguration('junction.showFullHistory') ||
            e.affectsConfiguration('junction.steerKeybinding') ||
            e.affectsConfiguration('editor.tokenColorCustomizations')
        );
    }
}
