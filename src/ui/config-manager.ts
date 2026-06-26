/**
 * ConfigManager — handles VS Code configuration for the Junction chat UI.
 *
 * Responsible for:
 * - Reading/writing extension settings (sendBehavior, lookAndFeel, etc.)
 * - Reading/writing animation settings (globalState)
 * - Building config payloads to send to the webview
 * - Sandbox/approval mode configuration UI
 *
 * Extracted from chatBase.ts.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/agentBridgeConfig';
import { ChoiceMenuItem } from '../bridges/types';
import { buildSandboxChoiceItems, normalizeSandboxControlSelection, sandboxControlDescription } from '../bridges/sandboxControls';
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
        const perBridgeKey = bridgeId ? `${bridgeId}.followUpMode` : '';
        let mode = perBridgeKey ? config().get<string>(perBridgeKey, 'default') : 'default';
        if (!mode || mode === 'default') {
            mode = config().get<string>('followUpMode', 'queue');
        }
        return (mode === 'steer' || mode === 'interrupt') ? mode : 'queue';
    }

    /** Send full config to the webview. */
    buildConfigPayload(): WebviewConfigPayload {
        const reasoningDisplay = this.readReasoningDisplayMode();
        const animSettings = this.context.globalState.get<any>('junction.animSettings');
        return {
            type: 'config',
            sendBehavior: this.getSendBehavior(),
            reasoningDisplay,
            extraRichText: config().get<boolean>('extraRichText', true),
            goodFonts: config().get<boolean>('goodFonts', false),
            toolOutputWordWrap: this.readToolOutputWordWrap(),
            alwaysShowUsageChip: config().get<boolean>('alwaysShowUsageChip', false),
            compactTimelineMode: config().get<boolean>('compactTimelineMode', false),
            activityLayout: this.readActivityLayoutMode(),
            feedbackGlyphs: config().get<string>('feedbackGlyphs', 'vector-arrows'),
            activityRail: config().get<boolean>('activityStream.rail', true),
            activityDots: config().get<string>('activityStream.dots', 'status'),
            activityCondensed: config().get<boolean>('activityStream.condensed', true),
            queueDisplayMode: config().get<string>('queueDisplayMode', 'auto'),
            betaForkRewind: false,
            bubbleRadius: config().get<number>('bubble.radius', 16),
            bubbleTip: config().get<string>('bubble.tip', 'none'),
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

    /** Write latest animation settings snapshot for UI debugging. */
    async writeAnimDebugFile(data: {
        config?: any;
        mode?: string;
        color?: string;
        loaderColor?: string;
        splashColor?: string;
        activeTab?: string;
    }): Promise<void> {
        const dir = path.join(this.context.globalStorageUri.fsPath, 'debug-captures');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'animation-settings-debug.json');
        const payload = {
            savedAt: new Date().toISOString(),
            activeTab: data.activeTab,
            mode: data.mode,
            color: data.color,
            loaderColor: data.loaderColor,
            splashColor: data.splashColor,
            config: data.config ?? {},
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    }

    /** Build sandbox/approval choice items for the webview. */
    buildSandboxChoices(bridgeId: string): ChoiceMenuItem[] {
        return buildSandboxChoiceItems(bridgeId, this.readSandboxMode(bridgeId), this.readApprovalMode(bridgeId));
    }

    sandboxDisplayDescription(bridgeId: string): string {
        return sandboxControlDescription(bridgeId, this.readSandboxMode(bridgeId), this.readApprovalMode(bridgeId));
    }

    readSandboxMode(bridgeId = ''): string {
        return this.readScopedMode(bridgeId, 'sandboxMode');
    }

    readApprovalMode(bridgeId = ''): string {
        return this.readScopedMode(bridgeId, 'approvalMode');
    }

    readSandboxSelection(bridgeId = ''): { sandbox: string; approval: string } {
        return normalizeSandboxControlSelection(
            bridgeId,
            this.readSandboxMode(bridgeId),
            this.readApprovalMode(bridgeId),
        );
    }

    private readScopedMode(bridgeId: string, key: 'sandboxMode' | 'approvalMode'): string {
        const scoped = bridgeId ? this.context.globalState.get<string>(`junction.${bridgeId}.${key}`) : undefined;
        return scoped || config().get<string>(key, 'default');
    }

    readLookAndFeelMode(): 'compact' | 'timeline' | undefined {
        const lookAndFeel = config().inspect<string>('lookAndFeel');
        const raw = lookAndFeel?.workspaceFolderValue
            ?? lookAndFeel?.workspaceValue
            ?? lookAndFeel?.globalValue;
        return (raw === 'compact' || raw === 'timeline') ? raw : undefined;
    }

    readReasoningDisplayMode(): 'compact' | 'chronological' {
        const cfg = config();
        const raw = this.readLookAndFeelMode() ?? cfg.get<string>('reasoningDisplay', 'compact');
        return (raw === 'timeline' || raw === 'chronological') ? 'chronological' : 'compact';
    }

    readActivityLayoutMode(): 'accordion' | 'timeline' {
        const cfg = config();
        // 1. Explicit unified look-and-feel knob wins.
        const lookAndFeel = this.readLookAndFeelMode();
        if (lookAndFeel) return lookAndFeel === 'timeline' ? 'timeline' : 'accordion';
        // 2. Legacy explicit layout key (only if the user actually set it).
        const legacy = this.explicitValue('activityStream.layout');
        if (legacy) return legacy === 'timeline' ? 'timeline' : 'accordion';
        // 3. The reasoning-display axis the user set (chronological ⇒ timeline).
        //    Layout and reasoning display are the same axis; honoring this is what
        //    makes a `reasoningDisplay` change actually swap the stream layout.
        const reasoning = this.explicitValue('reasoningDisplay');
        if (reasoning) return (reasoning === 'chronological' || reasoning === 'timeline') ? 'timeline' : 'accordion';
        // 4. Nothing set anywhere → honor the lookAndFeel package.json default.
        const def = cfg.inspect<string>('lookAndFeel')?.defaultValue;
        return def === 'compact' ? 'accordion' : 'timeline';
    }

    /** Return a setting's value only when the user set it in some scope (ignores
     *  the package.json default), so callers can distinguish "unset" from default. */
    private explicitValue(key: string): string | undefined {
        const i = config().inspect<string>(key);
        return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
    }

    readToolOutputWordWrap(): 'off' | 'on' {
        const raw = config().get<string>('toolOutputWordWrap', 'auto');
        if (raw === 'on' || raw === 'off') return raw;
        const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const editorWrap = vscode.workspace.getConfiguration('editor', resource).get<string>('wordWrap', 'off');
        return editorWrap && editorWrap !== 'off' ? 'on' : 'off';
    }

    async updateSandboxMode(mode: string, bridgeId = ''): Promise<void> {
        if (bridgeId) {
            await this.context.globalState.update(`junction.${bridgeId}.sandboxMode`, mode);
            return;
        }
        await config().update('sandboxMode', mode, vscode.ConfigurationTarget.Global);
    }

    async updateApprovalMode(mode: string, bridgeId = ''): Promise<void> {
        if (bridgeId) {
            await this.context.globalState.update(`junction.${bridgeId}.approvalMode`, mode);
            return;
        }
        await config().update('approvalMode', mode, vscode.ConfigurationTarget.Global);
    }

    /** Check if a config change event affects our settings. */
    static affectsChatConfig(e: vscode.ConfigurationChangeEvent): boolean {
        return (
            e.affectsConfiguration('junction.activityStream') ||
            e.affectsConfiguration('junction.activityStream.condensed') ||
            e.affectsConfiguration('junction.beta.openclawForkRewind') ||
            e.affectsConfiguration('junction.bubble') ||
            e.affectsConfiguration('junction.lookAndFeel') ||
            e.affectsConfiguration('junction.feedbackGlyphs') ||
            e.affectsConfiguration('junction.reasoningDisplay') ||
            e.affectsConfiguration('junction.sendBehavior') ||
            e.affectsConfiguration('junction.extraRichText') ||
            e.affectsConfiguration('junction.goodFonts') ||
            e.affectsConfiguration('junction.toolOutputWordWrap') ||
            e.affectsConfiguration('junction.alwaysShowUsageChip') ||
            e.affectsConfiguration('junction.compactTimelineMode') ||
            e.affectsConfiguration('junction.showFullHistory') ||
            e.affectsConfiguration('junction.steerKeybinding') ||
            e.affectsConfiguration('editor.wordWrap') ||
            e.affectsConfiguration('editor.tokenColorCustomizations')
        );
    }
}
