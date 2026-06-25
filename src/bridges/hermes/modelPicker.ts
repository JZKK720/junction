import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getHermesBaseUrl, getHermesHome } from '../../config/agentBridgeConfig';
import { jsonRequest } from '../http';
import {
    BridgeSelectionState,
    ChoiceMenuItem,
    ModelChoice,
} from '../types';
import { modelChoiceDisplay } from '../modelPicker';
import { Logger } from '../../utils/logger';

const HERMES_THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

interface HermesModelPickerDeps {
    isApiMode(): boolean;
    apiBase(): string;
    apiHeaders(key?: string): Record<string, string>;
    ensureConnected(): Promise<void>;
    request<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    selection(): BridgeSelectionState;
    setSelection(selection: BridgeSelectionState): void;
    activeSessionId(): string | null;
    updateActiveSessionModel(modelId: string): void;
    setSessionConfig(key: string, value: string): Promise<void>;
}

export class HermesModelPicker {
    private ollamaChatModels: Set<string> | null = null;

    constructor(private readonly deps: HermesModelPickerDeps) {}

    async listModelChoices(selectedModel?: string, selectedThinking?: string): Promise<ModelChoice[]> {
        if (this.deps.isApiMode()) {
            try {
                const res = await jsonRequest<{ data?: Array<{ id: string }> }>(
                    `${this.deps.apiBase()}/v1/models`,
                    { headers: this.deps.apiHeaders(), timeoutMs: 5000 },
                );
                const data = Array.isArray(res?.data) ? res.data : [];
                return data.map((m) => ({
                    id: m.id,
                    label: m.id,
                    model: m.id,
                    checked: selectedModel === m.id,
                }));
            } catch (err) {
                Logger.getInstance().warn('Hermes API-server model list failed', err);
                return [];
            }
        }

        await this.deps.ensureConnected();
        const payload = await this.deps.request<any>(
            'model.options',
            { session_id: this.deps.activeSessionId() || '' },
            30000,
        );
        const providers = Array.isArray(payload?.providers) ? payload.providers : [];
        const payloadCurrentProvider = String(payload?.current_provider || payload?.currentProvider || '');
        const payloadCurrentModel = String(payload?.current_model || payload?.currentModel || '');
        const whitelist = await readHermesProviderWhitelist();
        const choices: ModelChoice[] = [];
        const addMore: ChoiceMenuItem[] = [];

        for (const provider of providers) {
            const slug = String(provider.slug || provider.id || provider.name || '');
            if (slug && whitelist && !providerAllowedByYaml(slug, whitelist)) continue;
            const authenticated = provider.authenticated === true || provider.provider_configured === true;
            if (!slug || !authenticated) {
                if (slug) addMore.push(this.buildAddProviderItem(provider, slug));
                continue;
            }

            const models = Array.isArray(provider.models) ? provider.models : [];
            const ollamaChat = slug.toLowerCase() === 'ollama' ? await this.loadOllamaChatModels() : null;
            const modelItems: ModelChoice[] = [];
            let providerHasSelected = false;
            for (const raw of models) {
                const model = typeof raw === 'string' ? raw : String(raw.id || raw.model || raw.name || '');
                if (!model) continue;
                if (isNonChatModelId(model)) continue;
                if (ollamaChat && ollamaChat.size && !ollamaChat.has(model)) continue;
                const id = slug ? `${slug}/${model}` : model;
                const isPayloadCurrent = !selectedModel
                    && (
                        raw?.is_current === true
                        || raw?.current === true
                        || ((provider.is_current === true || provider.current === true || !payloadCurrentProvider || payloadCurrentProvider === slug)
                            && !!payloadCurrentModel
                            && (payloadCurrentModel === model || payloadCurrentModel === id))
                    );
                const isSelected = selectedModel === id || selectedModel === model || isPayloadCurrent;
                if (isSelected) providerHasSelected = true;
                const efforts = reasoningEffortsFromRaw(raw);
                const explicitlyNoReasoning = raw && typeof raw === 'object'
                    && (raw.supports_reasoning === false || raw.supportsReasoning === false || raw.reasoning === false);
                const supportsReasoning = !explicitlyNoReasoning;
                const levels = supportsReasoning ? (efforts.length ? efforts : HERMES_THINKING_LEVELS) : [];
                modelItems.push({
                    id,
                    label: raw?.label || raw?.name || model,
                    description: supportsReasoning ? 'reasoning' : undefined,
                    provider: slug,
                    model,
                    supportsReasoning,
                    icon: supportsReasoning ? 'lightbulb' : 'symbol-method',
                    checked: isSelected,
                    children: levels.length ? levels.map((level) => ({
                        id: `${id}:thinking:${level}`,
                        label: level,
                        icon: 'thinking',
                        thinking: level,
                        checked: isSelected && selectedThinking === level,
                    })) : undefined,
                });
            }
            if (!modelItems.length) continue;
            choices.push({
                id: `hermesprovider:${slug}`,
                label: String(provider.name || slug),
                description: `${modelItems.length} model${modelItems.length === 1 ? '' : 's'}${providerHasSelected ? ' · current' : ''}`,
                icon: 'server',
                parentSelectable: false,
                children: modelItems,
            } as ModelChoice);
        }

        if (!choices.length) {
            choices.push({
                id: 'hermes-agent',
                label: 'hermes-agent',
                model: 'hermes-agent',
                icon: 'symbol-method',
                checked: !selectedModel,
            });
        }
        if (addMore.length) {
            addMore.sort((a, b) => String(a.label).localeCompare(String(b.label)));
            choices.push({
                id: 'hermes:addmore',
                label: 'Add more…',
                description: `${addMore.length} more providers — sign in or add a key`,
                icon: 'add',
                parentSelectable: false,
                children: addMore,
            } as ModelChoice);
        }
        return choices;
    }

    async selectModelChoice(data: any): Promise<{ display: string; modelId: string; thinking?: string } | null> {
        if (data?.addProvider || String(data?.id ?? '').startsWith('hermes:addprovider:')) {
            await this.openProviderSetup(String(data.provider ?? ''), String(data.authType ?? ''));
            return null;
        }

        const provider = String(data.provider ?? '');
        const model = String(data.model ?? data.id ?? '').replace(/^.*:/, '');
        if (!model) return null;
        const modelId = provider ? `${provider}/${model}` : model;
        const thinking = data.thinking !== undefined ? String(data.thinking) : this.deps.selection().thinking;
        this.deps.setSelection({ modelId, thinking });
        if (this.deps.activeSessionId()) {
            await this.deps.setSessionConfig('model', `${quoteHermesSlashArg(model)} --provider ${quoteHermesSlashArg(provider)} --session`);
            this.deps.updateActiveSessionModel(modelId);
        }
        return { display: modelChoiceDisplay(data, model), modelId, thinking };
    }

    private async loadOllamaChatModels(): Promise<Set<string>> {
        if (this.ollamaChatModels) return this.ollamaChatModels;
        const set = new Set<string>();
        try {
            const base = await readOllamaBaseUrl();
            const tags = await jsonRequest<{ models?: Array<{ name: string }> }>(`${base}/api/tags`, { timeoutMs: 1500 });
            const names = (tags?.models ?? []).map((m) => m.name).filter(Boolean);
            await Promise.all(names.map(async (name) => {
                try {
                    const show = await jsonRequest<{ capabilities?: string[] }>(
                        `${base}/api/show`,
                        { method: 'POST', body: { name }, timeoutMs: 1500 },
                    );
                    if (!Array.isArray(show?.capabilities) || show!.capabilities!.includes('completion')) set.add(name);
                } catch {
                    set.add(name);
                }
            }));
            this.ollamaChatModels = set;
        } catch {
            return new Set();
        }
        return set;
    }

    private buildAddProviderItem(provider: any, slug: string): ChoiceMenuItem {
        const authType = String(provider.auth_type || 'api_key');
        const isOauth = authType.startsWith('oauth');
        return {
            id: `hermes:addprovider:${slug}`,
            label: String(provider.name || slug),
            description: isOauth ? 'Sign in to enable' : `Add ${provider.key_env || 'API key'}`,
            icon: isOauth ? 'sign-in' : 'key',
            addProvider: true,
            provider: slug,
            authType,
        };
    }

    private async openProviderSetup(slug: string, _authType: string): Promise<void> {
        const base = getHermesBaseUrl().replace(/\/+$/, '');
        const url = slug ? `${base}/#/settings/providers/${encodeURIComponent(slug)}` : base;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        vscode.window.showInformationMessage(
            `Opening the Hermes dashboard to set up “${slug}”. Add the key / sign in there, then reopen the model picker.`,
        );
    }
}

function reasoningEffortsFromRaw(raw: any): string[] {
    if (!raw || typeof raw !== 'object') return [];
    const source =
        raw.supported_reasoning_efforts ?? raw.supportedReasoningEfforts ??
        raw.reasoning_efforts ?? raw.reasoning_levels ?? raw.reasoningLevels ??
        raw.thinking_levels ?? raw.thinkingLevels ?? raw.thinking_options ?? raw.thinkingOptions;
    if (!Array.isArray(source)) return [];
    return source
        .map((e) => (typeof e === 'string' ? e : typeof e?.id === 'string' ? e.id : ''))
        .filter((e): e is string => !!e);
}

const NON_CHAT_MODEL_RE = /(^|[-_/.:])(tts|speech|embed(ding)?s?|rerank(er)?|whisper|transcri\w+|ocr|moderation|guard(rails?)?|dall[-_]?e|stable[-_]?diffusion|sdxl?|flux|imagen|midjourney|sora|veo|kandinsky)([-_./:0-9]|$)/i;
function isNonChatModelId(id: string): boolean {
    return NON_CHAT_MODEL_RE.test(id);
}

async function readOllamaBaseUrl(): Promise<string> {
    try {
        const text = await fs.promises.readFile(path.join(getHermesHome(), 'config.yaml'), 'utf-8');
        const m = text.match(/\n\s{2}ollama:\s*\n(?:\s{4,}.*\n)*?\s{4,}base_url:\s*["']?([^"'\s]+)/);
        if (m) return m[1].replace(/\/v1\/?$/, '');
    } catch { /* default below */ }
    return 'http://127.0.0.1:11434';
}

async function readHermesProviderWhitelist(): Promise<Set<string> | null> {
    let text = '';
    try {
        text = await fs.promises.readFile(path.join(getHermesHome(), 'config.yaml'), 'utf-8');
    } catch {
        return null;
    }

    const allowed = new Set<string>();
    const junctionBlock = topLevelBlock(text, 'junction');
    const explicit = explicitJunctionProviderWhitelist(junctionBlock);
    if (explicit.size) return explicit;

    const modelBlock = topLevelBlock(text, 'model');
    if (modelBlock) addProviderAlias(allowed, yamlScalarValue(modelBlock, 'provider'));

    const providersBlock = topLevelBlock(text, 'providers');
    if (providersBlock) {
        for (const match of providersBlock.matchAll(/^\s{2}([A-Za-z0-9_.:-]+):\s*(?:#.*)?$/gm)) {
            addProviderAlias(allowed, match[1]);
            addProviderAlias(allowed, `custom:${match[1]}`);
        }
    }

    const customProvidersBlock = topLevelBlock(text, 'custom_providers');
    if (customProvidersBlock) {
        for (const key of ['slug', 'id', 'provider', 'name']) {
            for (const match of customProvidersBlock.matchAll(new RegExp(`^\\s*-?\\s*${key}:\\s*["']?([^"'\\n#]+)`, 'gm'))) {
                addProviderAlias(allowed, match[1]);
                addProviderAlias(allowed, `custom:${slugifyProviderName(match[1])}`);
            }
        }
    }

    return allowed.size ? allowed : null;
}

function explicitJunctionProviderWhitelist(block: string): Set<string> {
    const allowed = new Set<string>();
    const list = block.match(/^\s{2}(?:allowed_providers|provider_whitelist):\s*(?:#.*)?\n((?:\s*-\s*[^\n#]+.*\n?)*)/m)?.[1] ?? '';
    for (const match of list.matchAll(/^\s*-\s*["']?([^"'\n#]+)["']?/gm)) {
        addProviderAlias(allowed, match[1]);
    }
    const inline = block.match(/^\s{2}(?:allowed_providers|provider_whitelist):\s*\[([^\]]*)\]/m)?.[1] ?? '';
    for (const item of inline.split(',')) {
        addProviderAlias(allowed, item);
    }
    return allowed;
}

function topLevelBlock(text: string, key: string): string {
    const start = text.match(new RegExp(`^${key}:\\s*(?:#.*)?$`, 'm'));
    if (!start || start.index === undefined) return '';
    const from = start.index + start[0].length;
    const rest = text.slice(from);
    const end = rest.search(/\n\S[^:\n]*:\s*/);
    return end >= 0 ? rest.slice(0, end) : rest;
}

function yamlScalarValue(block: string, key: string): string {
    const match = block.match(new RegExp(`^\\s+${key}:\\s*["']?([^"'\\n#]+)`, 'm'));
    return match?.[1]?.trim() ?? '';
}

function addProviderAlias(set: Set<string>, value: string): void {
    const raw = value.trim();
    if (!raw || raw === '{}' || raw === '[]') return;
    const normalized = raw.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (!normalized) return;
    set.add(normalized);
    if (normalized.startsWith('custom:')) set.add(normalized.slice('custom:'.length));
}

function providerAllowedByYaml(slug: string, allowed: Set<string>): boolean {
    const normalized = slug.trim().toLowerCase();
    if (allowed.has(normalized)) return true;
    if (normalized.startsWith('custom:') && allowed.has(normalized.slice('custom:'.length))) return true;
    return allowed.has(`custom:${normalized}`);
}

function slugifyProviderName(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function quoteHermesSlashArg(value: string): string {
    if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) return value;
    return JSON.stringify(value);
}
