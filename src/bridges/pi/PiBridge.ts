import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, type ChildProcess } from 'child_process';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState, BridgeSession, ChatBridge, ChatScope,
    ChoiceMenuItem, HistoryMessage, ModelChoice, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';
import { buildKeyValueCommandOutput, buildTableCommandOutput, commandOutputToMarkdown } from '../commandOutput';
import { parseSlashCommand, slashRunId } from '../slashCommands';
import { modelChoiceDisplay, selectedThinking } from '../modelPicker';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type PiToolCallState = { name: string; args: any; argsText: string; started: boolean };
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function piConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.pi');
}

function expandHome(raw: string): string {
    if (!raw) return raw;
    if (raw === '~' || raw === '~/') return process.env.HOME || raw;
    if (raw.startsWith('~/')) return path.join(process.env.HOME || '~', raw.slice(2));
    return raw;
}

function defaultCliPath(): string {
    return '/home/e/sauce/openclaw-src/packages/pi-mono/packages/coding-agent/dist/cli.js';
}

function piCliPath(): string {
    const configured = expandHome(piConfig().get<string>('cliPath') || '');
    if (configured) return configured;
    return defaultCliPath();
}

function piHome(): string {
    return expandHome(piConfig().get<string>('home') || '');
}

export class PiBridge extends EventEmitter implements ChatBridge {
    readonly id = 'pi';
    readonly label = 'Pi';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: false,
        steering: true,
        usage: true,
        tools: true,
        timelineInterleaves: true,
        // pi has no junction-controllable sandbox/approval model (RPC exposes no
        // permission controls), so hide the openclaw-style sandbox/approvals chip.
        sandboxControls: false,
        // NOT hidesRawThinking: pi splits reasoning into its own `thinking_chunk`
        // channel (text_delta → agent_message, thinking_delta → thinking_chunk), so
        // agent_message is already the clean reply. hidesRawThinking is for bridges
        // whose raw thinking arrives in the assistant-text channel gated by a
        // [[reply_to_current]] marker (openclaw); setting it here made the shared
        // gate suppress pi's streaming reply (0 painted) while thinking ran.
    };

    private process: ChildProcess | null = null;
    private reader: readline.Interface | null = null;
    private pending = new Map<string, Pending>();
    private requestId = 0;
    private stderr = '';
    private activeSessionId: string | null = null;
    // The pi cli holds ONE bound session at a time. junction is multi-session, so
    // before any get_messages/prompt we must switch_session the cli to the target.
    // Tracks which session the cli is currently bound to, to avoid redundant switches.
    private boundSessionId: string | null = null;
    private selection: BridgeSelectionState = {};
    private modelMetaById = new Map<string, any>();
    private knownSessions = new Map<string, { title: string; model?: string; sessionFile?: string }>();
    private runText = new Map<string, string>();
    private toolCalls = new Map<string, PiToolCallState>();
    private pendingFileContext: string | null = null;

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, { title: string; model?: string; sessionFile?: string }]>>('junction.pi.knownSessions');
        if (saved) this.knownSessions = new Map(saved);
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.pi.activeSessionId', null);
    }

    async connect(): Promise<boolean> {
        if (this.isConnected()) return true;
        const cliPath = piCliPath();
        if (!piCliUsable(cliPath)) {
            Logger.getInstance().warn('Pi CLI not usable: ' + cliPath);
            this.emit('disconnected');
            return false;
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const env = { ...process.env };
        const home = piHome();
        if (home) env.HOME = home;
        try {
            const args = ['--mode', 'rpc'];
            this.process = spawn('node', [cliPath, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
            this.process.stderr?.on('data', (chunk) => { this.stderr += String(chunk); });
            this.process.on('exit', () => this.handleExit());
            this.reader = readline.createInterface({ input: this.process.stdout! });
            this.reader.on('line', (line) => this.handleLine(line));
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (this.process.exitCode !== null) throw new Error(`Pi exited: ${this.stderr}`);
            const state = await this.request('get_state', {}, 15000);
            const boundId = String(state?.sessionId || `pi-${Date.now()}`);
            this.boundSessionId = boundId;
            // Keep the user's last-viewed session as active across reconnects; only
            // adopt the cli's fresh session when we have none.
            if (!this.activeSessionId) this.activeSessionId = boundId;
            this.knownSessions.set(boundId, {
                title: state?.sessionName || 'Pi chat',
                model: state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : undefined,
                sessionFile: state?.sessionFile,
            });
            this.syncSelectionFromState(state);
            this.persistSessions();
            this.emit('connected');
            return true;
        } catch (err) {
            Logger.getInstance().error('Pi connect failed', err);
            this.disconnect();
            this.emit('disconnected');
            return false;
        }
    }

    disconnect(): void {
        this.reader?.close();
        this.reader = null;
        if (this.process) this.process.kill();
        this.process = null;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Pi bridge disconnected'));
        }
        this.pending.clear();
        this.emit('disconnected');
    }

    isConnected(): boolean { return !!this.process && this.process.exitCode === null; }
    async initializeWorkspace(): Promise<void> {}
    async registerRuntimeIntegrations(): Promise<void> {}
    async configure(): Promise<void> { await vscode.commands.executeCommand('junction.openSettings'); }
    setPendingFileContext(context: string): void { this.pendingFileContext = context; }
    getPendingFileContext(): string | null { const c = this.pendingFileContext; this.pendingFileContext = null; return c; }
    getCurrentSessionKey(): string | null { return this.activeSessionId; }
    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> { return new Map(); }
    setActiveSession(_folderUri: vscode.Uri, key: string): void { this.activeSessionId = key; this.persistSessions(); }

    async createChat(_folderUri?: vscode.Uri): Promise<string> {
        await this.ensureConnected();
        await this.request('new_session', {}, 30000).catch(() => undefined);
        const state = await this.request('get_state', {}, 15000);
        const id = String(state?.sessionId || `pi-${Date.now()}`);
        this.activeSessionId = id;
        this.boundSessionId = id;
        this.knownSessions.set(id, {
            title: state?.sessionName || 'New Pi chat',
            model: state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : undefined,
            sessionFile: state?.sessionFile,
        });
        this.syncSelectionFromState(state);
        this.persistSessions();
        return id;
    }

    /**
     * The pi cli binds a single session. Before reading history or prompting a
     * given junction session, switch the cli to it (by its on-disk sessionFile)
     * unless it is already bound. Without this, get_messages/prompt hit whatever
     * session the cli last bound — causing empty history and cross-session bleed.
     */
    private async ensureSessionLoaded(key: string | null | undefined): Promise<void> {
        const id = String(key || '').trim();
        if (!id || id === this.boundSessionId) return;
        const file = this.knownSessions.get(id)?.sessionFile;
        if (!file) { this.boundSessionId = id; return; }
        await this.request('switch_session', { sessionPath: file }, 15000).catch(() => undefined);
        const state = await this.request('get_state', {}, 10000).catch(() => null);
        this.boundSessionId = String(state?.sessionId || id);
        if (state?.sessionFile) {
            const known = this.knownSessions.get(this.boundSessionId) ?? { title: String(state?.sessionName || 'Pi chat') };
            this.knownSessions.set(this.boundSessionId, {
                ...known,
                model: state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : known.model,
                sessionFile: state.sessionFile,
            });
            this.syncSelectionFromState(state);
            this.persistSessions();
        }
    }

    async listSessions(_scope: ChatScope = 'all', includeArchived = false, archivedKeys: ReadonlySet<string> = new Set()): Promise<BridgeSession[]> {
        const sessions = Array.from(this.knownSessions.entries()).map(([key, value]) => ({
            key,
            title: value.title,
            model: value.model,
            isActive: key === this.activeSessionId,
            isArchived: archivedKeys.has(key),
            groupId: 'pi',
            groupLabel: 'Pi',
        }));
        return includeArchived ? sessions : sessions.filter((s) => !s.isArchived);
    }

    async renameSession(key: string, label: string): Promise<void> {
        if (key === this.activeSessionId && this.isConnected()) {
            await this.request('set_session_name', { name: label }, 15000).catch(() => undefined);
        }
        const known = this.knownSessions.get(key) ?? { title: key };
        known.title = label;
        this.knownSessions.set(key, known);
        this.persistSessions();
    }

    async getSessionHistory(): Promise<HistoryMessage[]> {
        if (!await this.ensureConnected().then(() => true).catch(() => false)) return [];
        await this.ensureSessionLoaded(this.activeSessionId);
        const res = await this.request('get_messages', {}, 30000).catch(() => null);
        const messages: any[] = Array.isArray(res?.messages) ? res.messages : [];
        Logger.getInstance().captureDebugStream('pi-history-rpc', {
            sessionKey: this.activeSessionId,
            inputCount: messages.length,
            inputMessages: messages,
        });
        captureBridgeHistoryDebug(this.id, 'history-native', {
            operation: 'getSessionHistory.rpc',
            sessionKey: this.activeSessionId,
            inputCount: messages.length,
            inputMessages: messages,
        });
        const normalized = normalizePiHistoryMessages(messages);
        Logger.getInstance().captureDebugStream('pi-history-normalized', {
            sessionKey: this.activeSessionId,
            inputCount: messages.length,
            outputCount: normalized.length,
            outputMessages: normalized,
        });
        captureBridgeHistoryDebug(this.id, 'history-normalized', {
            operation: 'getSessionHistory.rpc',
            sessionKey: this.activeSessionId,
            inputCount: messages.length,
            outputCount: normalized.length,
            outputMessages: normalized,
        });
        return normalized;
    }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        await this.ensureConnected();
        if (!this.activeSessionId) await this.createChat();
        await this.ensureSessionLoaded(this.activeSessionId);
        await this.applySelection();
        const runId = `pi-${Date.now()}`;
        const sessionKey = this.activeSessionId!;
        this.runText.set(runId, '');
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });
        const workspace = context?.workspaceFolder || context?.workspace;
        const text = workspace ? `Chat: VS Code.\nworkspace: ${workspace}\ntreat paths as relative to workspace.\n\n${message}` : message;
        captureBridgeDebug(this.id, 'request', {
            operation: 'sendChatMessage',
            sessionKey,
            runId,
            message,
            outboundText: text,
            context,
        });
        await this.request('prompt', { message: text }, 30000).catch((err) => {
            this.emit('stream', { type: 'agent_message', runId, text: `Error: ${err.message || err}`, sessionKey });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey });
        });
        return { runId, sessionKey };
    }

    async executeSlashCommand(command: string, context?: BridgeContext): Promise<any> {
        const parsed = parseSlashCommand(command);
        if (!parsed) return this.sendChatMessage(command, context);
        if (parsed.name === 'status' || parsed.name === 'models' || parsed.name === 'commands') {
            await this.ensureConnected();
            const runId = slashRunId(this.id, parsed.name);
            const sessionKey = this.activeSessionId || await this.createChat();
            captureBridgeDebug(this.id, 'request', {
                operation: 'executeSlashCommand',
                sessionKey,
                runId,
                command,
                parsed,
                context,
            });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });
            const commandOutput = await this.nativeSlash(parsed.name);
            this.emit('stream', { type: 'agent_message', runId, sessionKey, text: commandOutputToMarkdown(commandOutput), commandOutput });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey });
            return { runId, sessionKey };
        }
        return this.sendChatMessage(command, context);
    }

    async stopRun(sessionKey?: string, runId?: string): Promise<void> {
        if (!this.isConnected()) return;
        await this.request('abort', {}, 5000).catch(() => undefined);
        const key = sessionKey || this.activeSessionId || 'pi';
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: runId || `pi-stop-${Date.now()}`, sessionKey: key });
    }

    async getUsage(): Promise<any> {
        if (!this.isConnected()) return null;
        return this.request('get_session_stats', {}, 10000).catch(() => null);
    }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        if (!this.isConnected()) return false;
        await this.ensureSessionLoaded(sessionKey || this.activeSessionId);
        await this.request('steer', { message }, 10000).catch(() => null);
        return true;
    }

    canSteer(): boolean { return true; }
    canAdminInject(): boolean { return false; }
    getSelection(): BridgeSelectionState { return { ...this.selection }; }
    setSelection(selection: BridgeSelectionState): void { this.selection = { ...this.selection, ...selection }; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        await this.ensureConnected();
        if (!selectedModel || !selectedThinking) {
            const state = await this.request('get_state', {}, 10000).catch(() => null);
            if (state) {
                this.syncSelectionFromState(state);
                selectedModel = selectedModel || this.selection.modelId;
                selectedThinking = selectedThinking || this.selection.thinking;
            }
        }
        const res = await this.request('get_available_models', {}, 30000).catch(() => ({ models: [] }));
        const models: any[] = Array.isArray(res?.models) ? res.models : [];
        const byProvider = new Map<string, ModelChoice[]>();
        for (const model of models) {
            const provider = String(model.provider || '');
            const id = String(model.id || '');
            if (!provider || !id) continue;
            const modelId = `${provider}/${id}`;
            this.modelMetaById.set(modelId, model);
            const supportsReasoning = !!model.reasoning;
            const choice: ModelChoice = {
                id: modelId,
                label: id,
                description: provider,
                provider,
                model: id,
                supportsReasoning,
                icon: 'lightbulb',
                checked: selectedModel === modelId,
                children: supportsReasoning ? piReasoningChildren(modelId, model, selectedModel, selectedThinking) : undefined,
            };
            byProvider.set(provider, [...(byProvider.get(provider) || []), choice]);
        }
        return Array.from(byProvider.entries()).map(([provider, children]) => ({
            id: `provider:${provider}`,
            label: provider,
            description: `${children.length} model${children.length === 1 ? '' : 's'}`,
            provider,
            icon: 'database',
            checked: children.some((item) => item.checked || item.children?.some((child) => child.checked)),
            children,
        }));
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const provider = String(data.provider || '');
        const model = String(data.model || '').replace(/:thinking:.*$/, '');
        if (!provider || !model) return null;
        const thinking = selectedThinking(data, this.selection);
        const modelId = `${provider}/${model}`;
        this.setSelection({ modelId, thinking });
        if (this.isConnected()) {
            await this.request('set_model', { provider, modelId: model }, 30000).catch(() => undefined);
            await this.request('set_thinking_level', { level: this.effectiveThinkingLevel() }, 10000).catch(() => undefined);
        }
        return { display: modelChoiceDisplay(data, model), modelId, thinking };
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const cliPath = piCliPath();
        const installed = piCliUsable(cliPath);
        const connected = this.isConnected();
        return [{
            id: 'pi:status',
            label: connected ? 'Pi@pi' : (installed ? 'Pi ready' : 'Pi not found'),
            description: installed ? cliPath : 'Set junction.pi.cliPath to a built Pi coding-agent dist/cli.js',
            icon: connected ? 'check' : (installed ? 'hubot' : 'warning'),
            setup: !installed,
            bridgeId: 'pi',
        }, {
            id: 'pi:configure',
            label: 'Configure Pi',
            description: 'Bridge settings',
            icon: 'gear',
            setup: true,
            bridgeId: 'pi',
        }];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        if (data.id === 'pi:configure') await this.configure();
    }

    getEnvironmentLabel(): string { return 'Pi@pi'; }
    async getSlashSuggestions(prefix: string): Promise<Array<{ name: string; description?: string }>> {
        const p = prefix.replace(/^\//, '').toLowerCase();
        const fallback = [
            { name: 'status', description: 'Show Pi RPC state' },
            { name: 'models', description: 'Show Pi available models' },
            { name: 'commands', description: 'Show Pi native commands' },
        ];
        try {
            if (this.isConnected()) {
                const res = await this.request('get_commands', {}, 10000);
                const commands = (res?.commands || []).map((c: any) => ({ name: String(c.name || '').replace(/^\//, ''), description: c.description }));
                return [...fallback, ...commands].filter((item, index, all) => item.name && all.findIndex((x) => x.name === item.name) === index && (!p || item.name.toLowerCase().startsWith(p)));
            }
        } catch {}
        return fallback.filter((item) => !p || item.name.startsWith(p));
    }
    getToolStatus(): ToolStatusView | null { return null; }

    private async ensureConnected(): Promise<void> {
        if (!this.isConnected()) {
            const ok = await this.connect();
            if (!ok) throw new Error('Pi bridge is not connected');
        }
    }

    /**
     * Resolve concrete model-valid reasoning level using pi's own model metadata.
     * pi exposes `thinkingLevelMap` over RPC; use that instead of bridge-local
     * provider hard-codes.
     */
    private effectiveThinkingLevel(): string {
        let level = this.selection.thinking || 'medium';
        if (!PI_THINKING_LEVELS.includes(level)) level = 'medium';
        const meta = this.selection.modelId ? this.modelMetaById.get(this.selection.modelId) : undefined;
        const levels = piSupportedThinkingLevels(meta);
        return levels.includes(level) ? level : piClampThinkingLevel(level, levels);
    }

    private async applySelection(): Promise<void> {
        const raw = String(this.selection.modelId || '');
        const slash = raw.indexOf('/');
        if (slash > 0) {
            await this.request('set_model', { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) }, 30000).catch(() => undefined);
        }
        await this.request('set_thinking_level', { level: this.effectiveThinkingLevel() }, 10000).catch(() => undefined);
    }

    private async nativeSlash(name: string) {
        if (name === 'status') {
            const state = await this.request('get_state', {}, 10000);
            return buildKeyValueCommandOutput('/status', [
                { key: 'session', value: String(state?.sessionName || state?.sessionId || '') },
                { key: 'model', value: state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : 'unknown' },
                { key: 'thinking', value: String(state?.thinkingLevel || 'off') },
                { key: 'messages', value: String(state?.messageCount ?? 0) },
                { key: 'session file', value: String(state?.sessionFile || '') },
            ], 'Pi status');
        }
        if (name === 'models') {
            const items = await this.listModelChoices(this.selection.modelId, this.selection.thinking);
            const rows: string[][] = [];
            for (const provider of items) {
                for (const child of provider.children || []) rows.push([String(provider.label || provider.id), String(child.model || child.id), child.checked ? 'yes' : '']);
            }
            return buildTableCommandOutput('/models', ['Provider', 'Model', 'Selected'], rows, 'Pi models');
        }
        const res = await this.request('get_commands', {}, 10000);
        return buildTableCommandOutput(
            '/commands',
            ['Command', 'Source', 'Description'],
            (res?.commands || []).map((c: any) => [String(c.name || ''), String(c.source || ''), String(c.description || '')]),
            'Pi commands',
        );
    }

    private request(type: string, body: Record<string, any>, timeoutMs: number): Promise<any> {
        if (!this.process?.stdin) return Promise.reject(new Error('Pi process not started'));
        const id = `pi_${++this.requestId}`;
        const payload = { ...body, type, id };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Pi ${type} timed out. ${this.stderr}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.process!.stdin!.write(JSON.stringify(payload) + '\n');
        });
    }

    private handleLine(line: string): void {
        let data: any;
        try { data = JSON.parse(line); } catch { return; }
        captureBridgeDebug(this.id, 'native', {
            operation: 'rpc.line',
            sessionKey: this.activeSessionId,
            line,
            payload: data,
        });
        if (data?.type === 'response' && data.id && this.pending.has(data.id)) {
            const pending = this.pending.get(data.id)!;
            this.pending.delete(data.id);
            clearTimeout(pending.timer);
            if (data.success === false) pending.reject(new Error(data.error || 'Pi command failed'));
            else pending.resolve(data.data ?? {});
            return;
        }
        this.handleRpcEvent(data);
    }

    private handleRpcEvent(event: any): void {
        const runId = Array.from(this.runText.keys()).at(-1) || `pi-${Date.now()}`;
        const sessionKey = this.activeSessionId || runId;
        captureBridgeDebug(this.id, 'normalized', {
            operation: 'handleRpcEvent',
            sessionKey,
            runId,
            eventType: event?.type,
            event,
        });
        if (event.type === 'agent_start') {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });
            return;
        }
        if (event.type === 'agent_end') {
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey });
            return;
        }
        if (event.type === 'message_update') {
            const ev = event.assistantMessageEvent || {};
            if (ev.type === 'text_delta') {
                const next = (this.runText.get(runId) || '') + String(ev.delta || '');
                this.runText.set(runId, next);
                this.emit('stream', { type: 'agent_message', runId, sessionKey, text: next });
            } else if (ev.type === 'thinking_delta') {
                this.emit('stream', { type: 'thinking_chunk', runId, sessionKey, text: String(ev.delta || '') });
            } else if (ev.type === 'toolcall_start' || ev.type === 'toolcall_delta' || ev.type === 'toolcall_end') {
                this.trackToolCall(ev);
            }
            return;
        }
        if (event.type === 'tool_execution_start') {
            const id = String(event.toolCallId || '');
            const tracked = id ? this.toolCalls.get(id) : undefined;
            const args = event.args ?? tracked?.args ?? {};
            if (tracked) tracked.started = true;
            this.emit('stream', { type: 'tool_event', phase: 'start', runId, sessionKey, toolCallId: event.toolCallId, toolName: event.toolName || tracked?.name, args });
        } else if (event.type === 'tool_execution_end') {
            // Emit only start+result (like opencode). pi's tool result is a
            // structured { content: [{ type:'text', text }] } object — flatten to a
            // string so the pill shows the output, not a raw JSON blob. The
            // streaming `tool_execution_update` partials are dropped: they carry
            // cumulative object snapshots the webview's text-delta update path
            // can't consume, which spammed/garbled the pill.
            const id = String(event.toolCallId || '');
            const tracked = id ? this.toolCalls.get(id) : undefined;
            const toolName = String(event.toolName || tracked?.name || '');
            this.emit('stream', { type: 'tool_event', phase: 'result', runId, sessionKey, toolCallId: event.toolCallId, toolName, args: tracked?.args, result: piToolResultText(event.result, toolName), isError: !!event.isError });
            if (id) this.toolCalls.delete(id);
        }
    }

    private trackToolCall(ev: any): void {
        const partial = ev.partial || {};
        const content = Array.isArray(partial.content) ? partial.content : [];
        const block = content[Number(ev.contentIndex)] || ev.toolCall || {};
        const call = ev.toolCall || block || {};
        const id = String(call.id || block.id || '');
        if (!id) return;
        const previous = this.toolCalls.get(id) || { name: '', args: {}, argsText: '', started: false };
        if (ev.type === 'toolcall_delta') {
            previous.argsText += String(ev.delta || '');
        }
        if (ev.type === 'toolcall_end') {
            previous.name = String(call.name || previous.name || block.name || '');
            previous.args = call.arguments ?? block.arguments ?? parseJsonMaybe(previous.argsText) ?? previous.args ?? {};
        } else {
            previous.name = String(block.name || previous.name || '');
            if (Object.keys(previous.args || {}).length === 0 && block.arguments && typeof block.arguments === 'object') {
                previous.args = block.arguments;
            }
        }
        this.toolCalls.set(id, previous);
    }

    private handleExit(): void {
        this.reader?.close();
        this.reader = null;
        this.process = null;
        this.emit('disconnected');
    }

    private persistSessions(): void {
        this.context.workspaceState.update('junction.pi.knownSessions', Array.from(this.knownSessions.entries()));
        this.context.workspaceState.update('junction.pi.activeSessionId', this.activeSessionId);
    }

    private syncSelectionFromState(state: any): void {
        const modelId = state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : '';
        if (modelId) {
            this.modelMetaById.set(modelId, state.model);
            const known = this.activeSessionId ? this.knownSessions.get(this.activeSessionId) : undefined;
            if (known) known.model = modelId;
        }
        const thinking = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : '';
        this.selection = {
            ...this.selection,
            ...(modelId ? { modelId } : {}),
            ...(thinking ? { thinking } : {}),
        };
    }
}

function piSupportedThinkingLevels(model: any): string[] {
    if (!model?.reasoning) return ['off'];
    const map = model?.thinkingLevelMap;
    if (!map || typeof map !== 'object') return PI_THINKING_LEVELS.filter((level) => level !== 'xhigh');
    return PI_THINKING_LEVELS.filter((level) => {
        const mapped = map[level];
        if (mapped === null) return false;
        if (level === 'xhigh') return mapped !== undefined;
        return true;
    });
}

function piClampThinkingLevel(level: string, levels: string[]): string {
    const available = levels.length ? levels : ['off'];
    const requested = PI_THINKING_LEVELS.indexOf(level);
    if (requested === -1) return available[0];
    for (let i = requested; i < PI_THINKING_LEVELS.length; i++) {
        if (available.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i];
    }
    for (let i = requested - 1; i >= 0; i--) {
        if (available.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i];
    }
    return available[0];
}

function piReasoningChildren(modelId: string, model: any, selectedModel?: string, selectedThinking?: string): ModelChoice[] {
    const slash = modelId.indexOf('/');
    const provider = slash > 0 ? modelId.slice(0, slash) : '';
    const modelName = slash > 0 ? modelId.slice(slash + 1) : modelId;
    return piSupportedThinkingLevels(model).map((level) => ({
        id: `${modelId}:thinking:${level}`,
        label: level,
        icon: 'thinking',
        provider,
        model: modelName,
        thinking: level,
        checked: selectedThinking === level && selectedModel === modelId,
    }));
}

/** Flatten pi's structured tool result ({ content: [{ type:'text', text }] }) to text. */
function piToolResultText(raw: any, toolName?: string): string {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    const content = raw.content ?? raw.output ?? raw;
    let text = '';
    if (Array.isArray(content)) {
        text = content.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).filter(Boolean).join('\n');
        if (text) return compactPiListingResult(toolName, text);
    }
    if (typeof raw.text === 'string') return compactPiListingResult(toolName, raw.text);
    try { text = JSON.stringify(raw); } catch { text = String(raw); }
    return compactPiListingResult(toolName, text);
}

function compactPiListingResult(toolName: any, text: string): string {
    const name = String(toolName || '').toLowerCase();
    if (!/(^|_)(ls|list|tree|find|grep|search)/.test(name)) return text;
    const lines = String(text || '').split('\n');
    const limit = 80;
    if (lines.length <= limit) return text;
    return `${lines.slice(0, limit).join('\n')}\n... (${lines.length - limit} more lines; result shortened for Junction timeline)`;
}

function parseJsonMaybe(text: string): any | null {
    const trimmed = String(text || '').trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
}

export function normalizePiHistoryMessages(messages: any[]): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    const pendingToolCalls: Array<{ id: string; name: string }> = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        const normalized = normalizePiHistoryMessage(message);
        if (!normalized) continue;

        if (normalized.role === 'assistant' && Array.isArray((normalized as any).content)) {
            const parts = (normalized as any).content;
            for (const part of parts) {
                if (part?.type === 'toolCall' || part?.type === 'tool_use' || part?.type === 'tool-call') {
                    const hasResult = part.result !== undefined || part.output !== undefined;
                    if (!hasResult) {
                        pendingToolCalls.push({
                            id: String(part.id ?? part.toolCallId ?? `pi-tool:${pendingToolCalls.length}`),
                            name: String(part.name ?? part.toolName ?? ''),
                        });
                    }
                }
            }
        }

        if (pendingToolCalls.length && isPiToolResultEcho(normalized)) {
            const pending = pendingToolCalls.shift()!;
            out.push({
                role: 'toolResult',
                content: piToolResultText((normalized as any).content, pending.name),
                toolCallId: pending.id,
                toolName: pending.name,
                isError: false,
            } as any);
            continue;
        }

        out.push(normalized);
    }

    return out;
}

function isPiToolResultEcho(message: HistoryMessage): boolean {
    if (message.role !== 'assistant') return false;
    const content = (message as any).content;
    if (typeof content === 'string') return !!content.trim();
    if (!Array.isArray(content) || content.length !== 1) return false;
    const part = content[0];
    return part?.type === 'text' && typeof part.text === 'string' && !!part.text.trim();
}

function normalizePiHistoryMessage(message: any): HistoryMessage | null {
    const role = normalizePiHistoryRole(message);
    if (role === 'toolResult') {
        const toolName = String(message?.toolName ?? message?.name ?? '');
        const content = piToolResultText(message?.result ?? message?.output ?? message?.content ?? message?.text ?? message, toolName);
        if (!content.trim()) return null;
        return {
            role,
            content,
            toolCallId: String(message?.toolCallId ?? message?.tool_call_id ?? message?.id ?? ''),
            toolName,
            isError: !!message?.isError,
        } as any;
    }
    if (role === 'user') {
        const content = extractPiMessageText(message);
        return content.trim() ? { role, content } : null;
    }
    const content = extractPiAssistantContent(message);
    const hasContent = Array.isArray(content)
        ? content.some((part) => String(part?.text ?? part?.thinking ?? part?.result ?? part?.output ?? part?.name ?? part?.toolName ?? '').trim())
        : String(content || '').trim();
    if (!hasContent) return null;
    const normalized: any = { role: 'assistant', content };
    if (piHasPendingToolCall(content)) normalized.stopReason = 'tool_use';
    return normalized as HistoryMessage;
}

function piHasPendingToolCall(content: any[] | string): boolean {
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
        if (!part || typeof part !== 'object') return false;
        if (!(part.type === 'toolCall' || part.type === 'tool_use' || part.type === 'tool-call')) return false;
        return part.result === undefined && part.output === undefined;
    });
}

function normalizePiHistoryRole(message: any): 'user' | 'assistant' | 'toolResult' {
    const role = String(message?.role ?? message?.type ?? '').toLowerCase().replace(/-/g, '_');
    if (role === 'user') return 'user';
    if (role === 'tool' || role === 'tool_result' || role === 'function') return 'toolResult';
    return 'assistant';
}

function extractPiAssistantContent(message: any): any[] | string {
    const rawParts = Array.isArray(message?.content)
        ? message.content
        : (Array.isArray(message?.parts) ? message.parts : null);
    if (!rawParts) return extractPiMessageText(message);

    const parts = rawParts.map(normalizePiHistoryPart).filter(Boolean);
    if (parts.length) return parts;
    return extractPiMessageText(message);
}

function normalizePiHistoryPart(part: any): any | null {
    if (typeof part === 'string') return part.trim() ? { type: 'text', text: part } : null;
    if (!part || typeof part !== 'object') return null;

    const type = String(part.type ?? part.kind ?? '').toLowerCase().replace(/-/g, '_');
    if (type === 'thinking' || type === 'reasoning') {
        const text = String(part.thinking ?? part.text ?? part.content ?? '');
        return text.trim() ? { type: 'reasoning', text } : null;
    }
    if (type === 'tool_result' || type === 'toolresult') {
        const name = String(part.toolName ?? part.name ?? '');
        const result = piToolResultText(part.result ?? part.output ?? part.content ?? part.text ?? part, name);
        return result.trim() ? {
            type: 'toolCall',
            id: String(part.toolCallId ?? part.tool_call_id ?? part.tool_use_id ?? part.id ?? ''),
            name,
            result,
            isError: !!part.isError,
        } : null;
    }
    if (type === 'tool_use' || type === 'tool_call' || type === 'toolcall' || type === 'function_call') {
        return {
            type: 'toolCall',
            id: String(part.toolCallId ?? part.tool_call_id ?? part.id ?? ''),
            name: String(part.toolName ?? part.name ?? part.function?.name ?? ''),
            input: part.input ?? part.args ?? part.arguments ?? part.function?.arguments ?? {},
            result: part.result !== undefined || part.output !== undefined ? piToolResultText(part.result ?? part.output, part.toolName ?? part.name) : undefined,
            isError: !!part.isError,
        };
    }
    const text = String(part.text ?? part.content ?? '');
    return text.trim() ? { type: 'text', text } : null;
}

function extractPiMessageText(message: any): string {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // Reply text only. Excluding `thinking` keeps raw reasoning out of the
        // history body (it belongs in the live reasoning channel, not the bubble).
        return content
            .filter((part) => part?.type !== 'thinking' && part?.type !== 'reasoning')
            .map((part) => part?.text || part?.content || '')
            .filter(Boolean)
            .join('\n');
    }
    return String(message?.text || message?.message || '');
}

function piCliUsable(cliPath: string): boolean {
    if (!fs.existsSync(cliPath)) return false;
    const codingAgentDist = path.dirname(cliPath);
    const monoRoot = path.resolve(codingAgentDist, '..', '..', '..');
    const aiDist = path.join(monoRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
    const agentDist = path.join(monoRoot, 'node_modules', '@earendil-works', 'pi-agent-core', 'dist', 'index.js');
    return fs.existsSync(aiDist) && fs.existsSync(agentDist);
}
