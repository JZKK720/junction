import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import {
    BridgeCapabilities, BridgeContext, BridgeSelectionState,
    BridgeSession, ChatBridge, ChatScope, ChoiceMenuItem, HistoryMessage,
    ModelChoice, ToolStatusView,
} from '../types';
import { Logger } from '../../utils/logger';
import { captureBridgeDebug, captureBridgeHistoryDebug } from '../../utils/debugCapture';
import { createGooseMapperState, mapGooseStreamJsonLine } from './events';
import { listGooseModelChoices, selectGooseModelChoice } from './modelPicker';
import { parseSlashCommand, slashRunId } from '../slashCommands';
import { buildKeyValueCommandOutput, buildTableCommandOutput, commandOutputToMarkdown, type CommandOutputPayload } from '../commandOutput';
import { t } from '../../l10n';

const execFileAsync = promisify(execFile);
const JUNCTION_SESSION_PREFIX = 'junction-';

function gooseConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.goose');
}

function expandHome(raw: string): string {
    if (!raw) return raw;
    if (raw === '~' || raw === '~/') return process.env.HOME || raw;
    if (raw.startsWith('~/')) return path.join(process.env.HOME || '~', raw.slice(2));
    return raw;
}

function gooseDataHome(): string {
    const raw = gooseConfig().get<string>('home') || '';
    if (raw) return expandHome(raw);
    const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
    return path.join(xdgData, 'goose');
}

function gooseConfigHome(): string {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '~', '.config'), 'goose');
}

function gooseBinaryPath(): string {
    const configured = gooseConfig().get<string>('binaryPath');
    if (configured) return expandHome(configured);
    const common = path.join(process.env.HOME || '~', 'bin', 'goose');
    if (fs.existsSync(common)) return common;
    try {
        const { execSync } = require('child_process');
        const resolved = execSync('which goose 2>/dev/null', { encoding: 'utf8' }).trim();
        if (resolved) return resolved;
    } catch {}
    return 'goose';
}

/** Sync best-effort check that the goose CLI is actually installed. goose is a
 *  stateless CLI bridge (spawned per request) with no persistent socket, so
 *  "available" — the binary resolves to a real file — is the correct notion of
 *  connected. Lets the bridge report ready even when it is not the active bridge,
 *  whose connect() is the only one that runs at startup. */
function gooseBinaryAvailable(): boolean {
    try {
        const bin = gooseBinaryPath();
        return path.isAbsolute(bin) && fs.existsSync(bin);
    } catch {
        return false;
    }
}

function gooseEnvFile(): string {
    const configured = (gooseConfig().get<string>('envFile') || '').trim();
    if (configured) return expandHome(configured);
    const hermling = path.join(process.env.HOME || '~', '.hermes-hermling', '.env');
    return fs.existsSync(hermling) ? hermling : '';
}

function readDotenv(file: string): Record<string, string> {
    if (!file) return {};
    try {
        const text = fs.readFileSync(file, 'utf8');
        const env: Record<string, string> = {};
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match) continue;
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            env[match[1]] = value;
        }
        return env;
    } catch {
        return {};
    }
}

function gooseProcessEnv(): NodeJS.ProcessEnv {
    const homeBin = path.join(process.env.HOME || '~', 'bin');
    const currentPath = process.env.PATH || '';
    return {
        ...process.env,
        ...readDotenv(gooseEnvFile()),
        PATH: currentPath.includes(homeBin) ? currentPath : `${homeBin}:${currentPath}`,
    };
}

function isNativeSessionId(key: string): boolean {
    return /^\d{8}_\d+$/.test(key);
}

interface KnownGooseSession {
    title: string;
    model?: string;
    nativeId?: string;
    hiddenContext?: string;
}

interface GooseCliSession {
    id: string;
    name: string;
    updatedAt?: string;
    cwd?: string;
}

export class GooseBridge extends EventEmitter implements ChatBridge {
    readonly id = 'goose';
    readonly label = 'goose';
    readonly capabilities: BridgeCapabilities = {
        sessions: true,
        models: true,
        agents: false,
        steering: false,
        usage: true,
        tools: true,
        timelineInterleaves: true,
    };

    private process: ChildProcess | null = null;
    private connected = false;
    private activeSessionId: string | null = null;
    private pendingFileContext: string | null = null;
    private selection: BridgeSelectionState = {};
    private knownSessions = new Map<string, KnownGooseSession>();
    private readonly commandCache: Array<{ name: string; description?: string }> = [
        { name: 'status', description: 'Show goose bridge status' },
        { name: 'sessions', description: 'List goose sessions' },
        { name: 'models', description: 'Show configured goose models' },
    ];

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        const saved = this.context.workspaceState.get<Array<[string, KnownGooseSession]>>('junction.goose.knownSessions');
        if (saved) this.knownSessions = new Map(saved);
        this.activeSessionId = this.context.workspaceState.get<string | null>('junction.goose.activeSessionId', null);
    }

    private persistSessions(): void {
        this.context.workspaceState.update('junction.goose.knownSessions', Array.from(this.knownSessions.entries()));
        this.context.workspaceState.update('junction.goose.activeSessionId', this.activeSessionId);
    }

    async connect(): Promise<boolean> {
        try {
            await execFileAsync(gooseBinaryPath(), ['--version'], { env: gooseProcessEnv(), timeout: 3000 });
            this.connected = true;
            this.emit('connected');
            return true;
        } catch (err) {
            Logger.getInstance().warn('goose bridge connect failed', err);
            this.connected = false;
            this.emit('disconnected');
            return false;
        }
    }

    disconnect(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.connected = false;
        this.emit('disconnected');
    }

    isConnected(): boolean {
        // No persistent socket: report ready whenever the CLI is installed, so a
        // configured-but-inactive goose isn't branded "Disconnected; setup required".
        return this.connected || gooseBinaryAvailable();
    }

    async initializeWorkspace(): Promise<void> {
        await this.connect();
    }

    async registerRuntimeIntegrations(): Promise<void> {
        await this.connect();
    }

    async configure(): Promise<void> {
        vscode.commands.executeCommand('junction.openSettings');
    }

    setPendingFileContext(context: string): void { this.pendingFileContext = context; }
    getPendingFileContext(): string | null {
        const ctx = this.pendingFileContext;
        this.pendingFileContext = null;
        return ctx;
    }

    getCurrentSessionKey(_folderUri?: vscode.Uri): string | null {
        return this.activeSessionId;
    }

    getSessionToFolder(): ReadonlyMap<string, vscode.Uri> { return new Map(); }

    setActiveSession(_folderUri: vscode.Uri, key: string): void {
        this.activeSessionId = key;
        this.persistSessions();
    }

    async createChat(_folderUri?: vscode.Uri): Promise<string> {
        const key = `${JUNCTION_SESSION_PREFIX}${Date.now()}`;
        this.activeSessionId = key;
        this.knownSessions.set(key, { title: `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}` });
        this.persistSessions();
        return key;
    }

    async listSessions(_scope: ChatScope = 'all', includeArchived = false): Promise<BridgeSession[]> {
        const native = await this.listNativeSessions().catch(() => []);
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
        const sessions: BridgeSession[] = [];
        const seen = new Set<string>();
        for (const item of native) {
            const alias = this.aliasForNativeSession(item.id, item.name);
            const known = this.knownSessions.get(alias) ?? this.knownSessions.get(item.id);
            const key = alias || item.id;
            seen.add(key);
            const archived = false;
            if (archived && !includeArchived) continue;
            sessions.push({
                key,
                title: known?.title || item.name || item.id,
                model: known?.model,
                isActive: key === this.activeSessionId || item.id === this.activeSessionId,
                folderUri: workspace,
                lastActiveTs: item.updatedAt ? Date.parse(item.updatedAt) : undefined,
            } as BridgeSession);
        }
        for (const [key, known] of this.knownSessions.entries()) {
            if (seen.has(key)) continue;
            sessions.push({
                key,
                title: known.title,
                model: known.model,
                isActive: key === this.activeSessionId,
                folderUri: workspace,
            } as BridgeSession);
        }
        return sessions;
    }

    async renameSession(key: string, label: string): Promise<void> {
        const entry = this.knownSessions.get(key) ?? { title: key };
        entry.title = label;
        this.knownSessions.set(key, entry);
        this.persistSessions();
    }

    async getSessionHistory(_limit?: number): Promise<HistoryMessage[]> {
        const key = this.activeSessionId;
        if (!key) return [];
        const exported = await this.exportSession(key).catch(() => null);
        captureBridgeHistoryDebug(this.id, 'history-native', {
            operation: 'getSessionHistory.export',
            sessionKey: key,
            exported,
        });
        const normalized = exported ? normalizeGooseHistory(exported.conversation ?? []) : [];
        captureBridgeHistoryDebug(this.id, 'history-normalized', {
            operation: 'getSessionHistory.export',
            sessionKey: key,
            outputCount: normalized.length,
            outputMessages: normalized,
        });
        return normalized;
    }

    async forkChat(parentSessionKey: string): Promise<string | null> {
        const source = await this.exportSession(parentSessionKey).catch(() => null);
        if (!source?.conversation) return null;
        const key = await this.createChat();
        const known = this.knownSessions.get(key);
        if (known) known.title = t('Fork of {0}', source.name || parentSessionKey);
        await this.injectMessage(key, '[Forked goose conversation context]\n' + summarizeGooseConversation(source.conversation));
        this.persistSessions();
        return key;
    }

    async sendChatMessage(message: string, context?: BridgeContext): Promise<any> {
        if (!this.activeSessionId) await this.createChat();
        const sessionKey = this.activeSessionId!;
        const runId = `goose-${Date.now()}`;
        const entry = this.knownSessions.get(sessionKey);
        const hidden = entry?.hiddenContext;
        const text = hidden ? `${hidden}\n\n${message}` : message;
        captureBridgeDebug(this.id, 'request', {
            operation: 'sendChatMessage',
            sessionKey,
            runId,
            message,
            outboundText: text,
            context,
        });
        this.emit('stream', { type: 'agent_lifecycle', phase: 'start', runId, sessionKey });

        try {
            await this.runGooseStream(sessionKey, runId, text, context);
            await this.syncNativeId(sessionKey).catch(() => {});
        } catch (err: any) {
            const msg = String(err?.message || err);
            Logger.getInstance().error('goose sendChatMessage failed', err);
            this.emit('stream', { type: 'agent_message', runId, text: `Error: ${msg}`, sessionKey });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'error', runId, sessionKey });
        }

        return { runId, sessionKey };
    }

    async executeSlashCommand(command: string, context?: BridgeContext): Promise<any> {
        const parsed = parseSlashCommand(command);
        if (!parsed) return this.sendChatMessage(command, context);
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
        try {
            const commandOutput = await this.runNativeSlash(parsed.name);
            const text = commandOutputToMarkdown(commandOutput);
            this.emit('stream', { type: 'agent_message', runId, text, commandOutput, sessionKey });
            this.emit('stream', { type: 'agent_lifecycle', phase: 'completed', runId, sessionKey });
            return { runId, sessionKey };
        } catch {
            return this.sendChatMessage(command, context);
        }
    }

    async stopRun(sessionKey?: string, runId?: string): Promise<void> {
        const key = sessionKey || this.activeSessionId || 'goose';
        const id = runId || `goose-stop-${Date.now()}`;
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.emit('stream', { type: 'agent_lifecycle', phase: 'cancelled', runId: id, sessionKey: key });
    }

    async getUsage(sessionKey: string): Promise<any> {
        const exported = await this.exportSession(sessionKey).catch(() => null);
        if (!exported) return null;
        return {
            inputTokens: exported.accumulated_input_tokens ?? exported.input_tokens,
            outputTokens: exported.accumulated_output_tokens ?? exported.output_tokens,
            totalTokens: exported.accumulated_total_tokens ?? exported.total_tokens,
            cost: exported.accumulated_cost,
        };
    }

    async getContextUsage(sessionKey: string): Promise<{ percentUsed?: number; usedTokens?: number; contextWindow?: number } | null> {
        const exported = await this.exportSession(sessionKey).catch(() => null);
        if (!exported) return null;
        const usedTokens = Number(exported.accumulated_total_tokens ?? exported.total_tokens);
        const contextWindow = Number(exported.model_config?.context_limit);
        return {
            usedTokens: Number.isFinite(usedTokens) ? usedTokens : undefined,
            contextWindow: Number.isFinite(contextWindow) ? contextWindow : undefined,
            percentUsed: Number.isFinite(usedTokens) && Number.isFinite(contextWindow) && contextWindow > 0
                ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
                : undefined,
        };
    }

    async injectMessage(sessionKey: string, message: string): Promise<boolean> {
        const entry = this.knownSessions.get(sessionKey) ?? { title: sessionKey };
        entry.hiddenContext = [entry.hiddenContext, message].filter(Boolean).join('\n\n');
        this.knownSessions.set(sessionKey, entry);
        this.persistSessions();
        return true;
    }

    async injectHiddenContext(sessionKey: string, _context: BridgeContext, message: string): Promise<boolean> {
        const entry = this.knownSessions.get(sessionKey) ?? { title: sessionKey };
        entry.hiddenContext = message;
        this.knownSessions.set(sessionKey, entry);
        this.persistSessions();
        return true;
    }

    canSteer(): boolean { return false; }
    canAdminInject(): boolean { return true; }

    setSelection(selection: BridgeSelectionState): void { this.selection = { ...this.selection, ...selection }; }
    getSelection(): BridgeSelectionState { return { ...this.selection }; }

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        return listGooseModelChoices(gooseConfigHome(), gooseDataHome(), selectedModel, selectedThinking);
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        const selected = selectGooseModelChoice(data, this.selection);
        if (!selected) return null;
        this.setSelection({ ...this.selection, modelId: selected.modelId, thinking: selected.thinking });
        if (this.activeSessionId) {
            const known = this.knownSessions.get(this.activeSessionId) ?? { title: this.activeSessionId };
            known.model = selected.modelId;
            this.knownSessions.set(this.activeSessionId, known);
            this.persistSessions();
        }
        return selected;
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const connected = this.isConnected();
        return [{
            id: 'goose:status',
            label: connected ? 'goose CLI ready' : 'goose CLI unavailable',
            description: connected ? gooseBinaryPath() : 'Set junction.goose.binaryPath or install goose',
            icon: connected ? 'check' : 'warning',
            setup: !connected,
            bridgeId: 'goose',
        }, {
            id: 'goose:configure',
            label: 'Configure goose',
            description: 'Bridge settings',
            icon: 'gear',
            setup: true,
            bridgeId: 'goose',
        }];
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        if (data.id === 'goose:configure') vscode.commands.executeCommand('junction.openSettings');
    }

    getEnvironmentLabel(): string {
        return 'gooseLing';
    }

    getSlashSuggestions(prefix: string): Array<{ name: string; description?: string }> {
        const p = prefix.replace(/^\//, '').toLowerCase();
        return this.commandCache.filter((c) => !p || c.name.toLowerCase().startsWith(p));
    }

    getToolStatus(): ToolStatusView | null {
        return {
            tools: [
                { name: 'developer', enabled: true },
                { name: 'todo', enabled: true },
                { name: 'skills', enabled: true },
                { name: 'summon', enabled: true },
            ],
        };
    }

    private async runGooseStream(sessionKey: string, runId: string, text: string, context?: BridgeContext): Promise<void> {
        const args = this.buildRunArgs(sessionKey, text, context);
        const cwd = context?.workspaceFolder || context?.workspace || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const child = spawn(gooseBinaryPath(), args, { cwd, env: gooseProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        this.process = child;
        const state = createGooseMapperState();
        const sessionKeyForEvent = sessionKey;
        let stderr = '';
        const rl = readline.createInterface({ input: child.stdout });

        await new Promise<void>((resolve, reject) => {
            child.stderr.on('data', (chunk) => { stderr += String(chunk); });
            rl.on('line', (line) => {
                captureBridgeDebug(this.id, 'native', {
                    operation: 'runGooseStream.stdout',
                    sessionKey: sessionKeyForEvent,
                    runId,
                    line,
                });
                const mapped = mapGooseStreamJsonLine(runId, line, state);
                captureBridgeDebug(this.id, 'normalized', {
                    operation: 'runGooseStream.stdout',
                    sessionKey: sessionKeyForEvent,
                    runId,
                    mapped,
                });
                for (const ev of mapped.events) this.emit('stream', { ...ev, sessionKey: sessionKeyForEvent });
            });
            child.on('error', reject);
            child.on('close', (code) => {
                this.process = null;
                rl.close();
                if (code === 0) {
                    if (state.text) {
                        const known = this.knownSessions.get(sessionKeyForEvent);
                        if (known && this.selection.modelId) known.model = this.selection.modelId;
                    }
                    resolve();
                } else {
                    reject(new Error(stderr.trim() || `goose exited with code ${code}`));
                }
            });
        });
    }

    private buildRunArgs(sessionKey: string, text: string, context?: BridgeContext): string[] {
        const args = ['run', '--quiet', '--output-format', 'stream-json', '--text', text];
        const selected = parseProviderModel(this.selection.modelId);
        if (selected.provider) args.push('--provider', selected.provider);
        if (selected.model) args.push('--model', selected.model);
        const extraSystem = this.selection.thinking && this.selection.thinking !== 'off'
            ? `Use reasoning effort: ${this.selection.thinking}.`
            : '';
        if (extraSystem) args.push('--system', extraSystem);
        if (isNativeSessionId(sessionKey)) {
            args.push('--resume', '--session-id', sessionKey);
        } else {
            args.push('--name', sessionKey);
            if (this.sessionLikelyExists(sessionKey)) args.push('--resume');
        }
        if (context?.workspaceFolder || context?.workspace) {
            args.push('--with-builtin', 'developer,todo,skills,summon');
        }
        return args;
    }

    private sessionLikelyExists(sessionKey: string): boolean {
        const known = this.knownSessions.get(sessionKey);
        return !!known?.nativeId || !sessionKey.startsWith(JUNCTION_SESSION_PREFIX);
    }

    private async listNativeSessions(): Promise<GooseCliSession[]> {
        const { stdout } = await execFileAsync(gooseBinaryPath(), ['session', 'list'], { env: gooseProcessEnv(), timeout: 10000 });
        return String(stdout).split(/\r?\n/).map(parseSessionListLine).filter(Boolean) as GooseCliSession[];
    }

    private async exportSession(key: string): Promise<any> {
        const args = ['session', 'export', '--format', 'json'];
        if (isNativeSessionId(key)) args.push('--session-id', key);
        else args.push('--name', key);
        const { stdout } = await execFileAsync(gooseBinaryPath(), args, { env: gooseProcessEnv(), maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
        return JSON.parse(String(stdout));
    }

    private async syncNativeId(sessionKey: string): Promise<void> {
        if (isNativeSessionId(sessionKey)) return;
        const sessions = await this.listNativeSessions();
        const match = sessions.find((s) => s.name === sessionKey);
        if (!match) return;
        const entry = this.knownSessions.get(sessionKey) ?? { title: sessionKey };
        entry.nativeId = match.id;
        this.knownSessions.set(sessionKey, entry);
        this.persistSessions();
    }

    private aliasForNativeSession(nativeId: string, name: string): string {
        for (const [key, known] of this.knownSessions.entries()) {
            if (known.nativeId === nativeId) return key;
        }
        return name.startsWith(JUNCTION_SESSION_PREFIX) ? name : nativeId;
    }

    private async runNativeSlash(name: string): Promise<CommandOutputPayload> {
        if (name === 'status') {
            const version = await execFileAsync(gooseBinaryPath(), ['--version'], { env: gooseProcessEnv(), timeout: 3000 }).then(r => String(r.stdout).trim()).catch(() => 'unknown');
            const envFile = gooseEnvFile();
            return buildKeyValueCommandOutput('/status', [
                { key: 'goose', value: version },
                { key: 'binary', value: gooseBinaryPath() },
                { key: 'config', value: gooseConfigHome() },
                { key: 'data', value: gooseDataHome() },
                { key: 'env file', value: envFile || 'none' },
            ], 'goose status');
        }
        if (name === 'sessions') {
            const sessions = await this.listNativeSessions();
            return buildTableCommandOutput(
                '/sessions',
                ['ID', 'Name', 'Workspace'],
                sessions.map((s) => [s.id, s.name, s.cwd || '']),
                'goose sessions',
            );
        }
        if (name === 'models') {
            const models = await this.listModelChoices(this.selection.modelId, this.selection.thinking);
            return buildTableCommandOutput(
                '/models',
                ['Model', 'Provider', 'Selected'],
                models.map((m) => [String(m.model || m.id || ''), String(m.provider || ''), m.checked ? 'yes' : '']),
                'goose models',
            );
        }
        throw new Error(`Unknown goose slash command: ${name}`);
    }
}

function parseSessionListLine(line: string): GooseCliSession | null {
    const match = line.match(/^(\S+)\s+-\s+(.*?)\s+-\s+(.+?)\s+-\s+(.+)$/);
    if (!match || match[1] === 'Available') return null;
    return { id: match[1], name: match[2], updatedAt: match[3], cwd: match[4] };
}

function normalizeGooseHistory(conversation: any[]): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    for (const message of conversation) {
        const content = Array.isArray(message?.content) ? message.content : [];
        const toolResponses = content.filter((p: any) => p?.type === 'toolResponse');
        if (toolResponses.length) {
            for (const part of toolResponses) {
                out.push({
                    role: 'toolResult' as any,
                    content: extractGooseToolResultText(part),
                    toolCallId: part.id,
                    toolName: '',
                    isError: !!part.toolResult?.isError,
                } as any);
            }
            continue;
        }
        if (message.role === 'user') {
            const text = content.map((p: any) => p?.text || '').join('');
            if (text) out.push({ role: 'user', content: text });
            continue;
        }
        if (message.role === 'assistant') {
            const parts = content.map((part: any) => {
                if (part?.type === 'thinking') return { type: 'thinking', thinking: part.thinking || part.text || '' };
                if (part?.type === 'text') return { type: 'text', text: part.text || '' };
                if (part?.type === 'toolRequest') {
                    const call = part.toolCall?.value ?? part.toolCall ?? {};
                    return {
                        type: 'toolCall',
                        id: part.id,
                        name: call.name || part.name || 'tool',
                        input: call.arguments ?? part.arguments ?? {},
                    };
                }
                return null;
            }).filter(Boolean);
            if (parts.length) out.push({ role: 'assistant', content: parts as any });
        }
    }
    return out;
}

function extractGooseToolResultText(part: any): string {
    const result = part?.toolResult?.value ?? part?.toolResult ?? '';
    if (typeof result === 'string') return result;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.map((item: any) => item?.text || '').filter(Boolean).join('\n');
    return text || JSON.stringify(result, null, 2);
}

function summarizeGooseConversation(conversation: any[]): string {
    return conversation.map((message) => {
        const role = String(message?.role ?? 'message').toUpperCase();
        const parts = Array.isArray(message?.content) ? message.content : [];
        const text = parts.map((part: any) => part.text || part.thinking || extractGooseToolResultText(part)).filter(Boolean).join('\n');
        return text ? `${role}: ${text}` : '';
    }).filter(Boolean).join('\n\n').slice(0, 20000);
}

function parseProviderModel(modelId?: string): { provider?: string; model?: string } {
    const raw = String(modelId || '');
    const slash = raw.indexOf('/');
    if (slash <= 0) return { model: raw || undefined };
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1).replace(/:thinking:.*$/, '') };
}
