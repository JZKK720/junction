import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getOpenClawConfigPath } from '../config/agentBridgeConfig';
import {
    ModelEntry,
    ProviderGroup,
    ModelCatalogBrowseView,
} from '../types/openclaw';
import { OPENCLAW_THINKING_LEVELS } from '../bridges/types';

/**
 * Internal cache structure — raw browse view + metadata
 */
interface ModelCache {
    providers: ProviderGroup[];
    timestamp: number;
    /** Flattened model list for menu lookups */
    flatModels: Map<string, ModelEntry>;
    /** SHA-256 of the serialized catalog, used for hash-based cache checks */
    catalogHash?: string;
}

export interface ModelChoice {
    id: string;
    label: string;
    description?: string;
    provider: string;
    model: string;
    supportsReasoning?: boolean;
    thinking?: string;
    icon?: string;
    checked?: boolean;
    children?: Array<{
        id: string;
        label: string;
        description?: string;
        icon?: string;
        checked?: boolean;
        thinking: string;
    }>;
}

interface AgentThinkingSource {
    levels: Array<{ id: string; label?: string }>;
    defaultLevel?: string;
}

/**
 * Manages the model catalog: fetch, cache, invalidate, and expose flat
 * webview-menu data for model selection.
 */
export class ModelManager {
    private cache: ModelCache | null = null;
    private lastCatalogHash: string | null = null;
    private staleCache: ModelCache | null = null;
    private logger: Logger;
    private authScopes: string[] = [];

    constructor() {
        this.logger = Logger.getInstance();
    }

    // ────────────────────────────────────────
    // Auth scopes (set from hello-ok response)
    // ────────────────────────────────────────

    /** Store auth scopes from the connect/hello-ok response. */
    setAuthScopes(scopes: string[]): void {
        this.authScopes = scopes;
        this.logger.debug('Auth scopes stored', { scopes });
    }

    /** Check if the connection has a specific scope. */
    hasScope(scope: string): boolean {
        return this.authScopes.includes(scope);
    }

    /** Returns the raw auth scopes array. */
    getAuthScopes(): string[] {
        return [...this.authScopes];
    }

    // ────────────────────────────────────────
    // Model Catalog
    // ────────────────────────────────────────

    /**
     * Fetch the model catalog from the gateway.
     * Results are cached; call `invalidate()` to force a re-fetch.
     */
    async getModels(gateway: GatewayConnection): Promise<ProviderGroup[]> {
        if (this.cache) {
            return this.cache.providers;
        }

        this.logger.info('Fetching model catalog from gateway...');

        try {
            const params: Record<string, unknown> = { view: 'default' };
            if (this.lastCatalogHash) {
                params.catalogHash = this.lastCatalogHash;
            }
            const payload = await gateway.sendRequest('models.list', params);

            // Hash-based cache check: gateway returns empty models + hash when unchanged
            const responseHash = payload?.hash;
            if (Array.isArray(payload?.models) && payload.models.length === 0 && responseHash && this.lastCatalogHash === responseHash) {
                this.logger.info('Model catalog unchanged (hash match), using cache');
                if (this.staleCache) {
                    this.cache = this.staleCache;
                    this.cache.timestamp = Date.now();
                }
                return this.cache ? this.cache.providers : [];
            }

            const providers = this.normalizeCatalog(payload);

            if (!providers.length) {
                this.logger.warn('models.list returned unexpected shape', payload);
                return [];
            }

            // Build flat lookup map
            const flatModels = new Map<string, ModelEntry>();
            for (const group of providers) {
                for (const raw of group.models) {
                    // Some gateways may nest model objects
                    const entry: ModelEntry = raw && typeof raw === 'object' ? raw : { id: String(raw), name: String(raw) };
                    const normalized = this.normalizeEntry(group.provider, entry);
                    const normalizedEntry = {
                        ...entry,
                        id: normalized.id,
                        provider: normalized.provider,
                    };
                    flatModels.set(normalized.provider ? `${normalized.provider}/${normalized.id}` : normalized.id, normalizedEntry);
                    flatModels.set(normalized.id, normalizedEntry);
                }
            }

            // Compute hash of the received catalog for future cache checks
            const catalogHash = responseHash
                ?? crypto.createHash('sha256').update(JSON.stringify(payload.models)).digest('hex');

            this.lastCatalogHash = catalogHash;
            this.staleCache = null; // consumed

            this.cache = {
                providers,
                timestamp: Date.now(),
                flatModels,
                catalogHash,
            };

            this.logger.info(`Cached ${flatModels.size} models from ${providers.length} providers`);
            return providers;
        } catch (error) {
            this.logger.error('Failed to fetch models', error);
            throw error;
        }
    }

    /**
     * Invalidate the model cache.
     * Call on reconnect via Group 1's `onReconnect`.
     */
    invalidate(): void {
        this.staleCache = this.cache; // stash for hash-match restore
        this.lastCatalogHash = this.cache?.catalogHash ?? null;
        this.cache = null;
        this.logger.debug('Model cache invalidated');
    }

    /**
     * Return the cached model list without fetching.
     * Returns null if cache is empty.
     */
    getCachedModels(): ProviderGroup[] | null {
        return this.cache?.providers ?? null;
    }

    /**
     * Look up a single model by ID from the cache.
     */
    getModelById(modelId: string): ModelEntry | undefined {
        return this.cache?.flatModels.get(modelId);
    }

    async getModelChoices(gateway: GatewayConnection, selectedModel?: string, selectedThinking?: string, _selectedAgentId?: string): Promise<ModelChoice[]> {
        const providers = await this.getModels(gateway);
        const configThinking = this.readConfigThinkingSources();
        const items: ModelChoice[] = [];
        for (const group of providers) {
            for (const model of group.models) {
                const entry: ModelEntry = typeof model === 'object' ? model : { id: String(model), name: String(model) };
                const normalized = this.normalizeEntry(group.provider, entry);
                const caps = entry.capabilities;
                const fullId = normalized.provider ? `${normalized.provider}/${normalized.id}` : normalized.id;
                const supportsReasoning = entry.reasoning === true
                    || this.hasReasoningVocabulary(entry)
                    || this.isKnownReasoningFamily(normalized.provider, normalized.id, fullId);
                const badges = [
                    group.providerName || normalized.provider,
                    entry.contextWindow ? `${entry.contextWindow.toLocaleString()} ctx` : '',
                    entry.default ? 'default' : '',
                    supportsReasoning ? 'reasoning' : '',
                    caps?.vision ? 'vision' : '',
                ].filter(Boolean);
                const thinkingLevels = supportsReasoning
                    ? this.getThinkingLevels(
                        entry,
                        configThinking.get(fullId) || configThinking.get(normalized.id)
                    )
                    : [];
                if (supportsReasoning && thinkingLevels.length === 0) {
                    this.logger.warn('Reasoning model has no advertised thinking levels; hiding submenu', { model: fullId });
                }
                items.push({
                    id: fullId,
                    label: entry.alias || entry.name || normalized.id,
                    description: entry.description || badges.join(' · '),
                    provider: normalized.provider,
                    model: normalized.id,
                    supportsReasoning,
                    icon: supportsReasoning ? 'lightbulb' : 'symbol-method',
                    checked: selectedModel === normalized.id || selectedModel === fullId,
                    children: supportsReasoning && thinkingLevels.length
                        ? thinkingLevels.map((level) => ({
                            id: `${fullId}:thinking:${level.id}`,
                            label: level.label || level.id,
                            description: 'Reasoning effort',
                            icon: 'thinking',
                            thinking: level.id,
                            checked: (selectedModel === normalized.id || selectedModel === fullId) && selectedThinking === level.id,
                        }))
                        : undefined,
                });
            }
        }
        return items;
    }

    private normalizeCatalog(payload: any): ProviderGroup[] {
        const root: ModelCatalogBrowseView | any = payload?.models && !Array.isArray(payload.models)
            ? payload.models
            : payload;

        if (Array.isArray(payload?.models)) {
            return this.groupFlatModels(payload.models);
        }

        if (Array.isArray(root?.models)) {
            return this.groupFlatModels(root.models);
        }

        if (Array.isArray(root?.providers)) {
            return root.providers.map((group: any) => ({
                provider: String(group.provider ?? group.id ?? 'default'),
                providerName: group.providerName ?? group.name,
                models: Array.isArray(group.models) ? group.models : [],
            }));
        }

        return [];
    }

    private groupFlatModels(models: ModelEntry[]): ProviderGroup[] {
        const groups = new Map<string, ProviderGroup>();
        for (const raw of models) {
            const entry: ModelEntry = raw && typeof raw === 'object' ? raw : { id: String(raw), name: String(raw) };
            const normalized = this.normalizeEntry(entry.provider || '', entry);
            const provider = normalized.provider || 'default';
            if (!groups.has(provider)) {
                groups.set(provider, { provider, providerName: provider, models: [] });
            }
            groups.get(provider)!.models.push({
                ...entry,
                id: normalized.id,
                provider: normalized.provider,
            });
        }
        return [...groups.values()];
    }

    private normalizeEntry(groupProvider: string, entry: ModelEntry): { provider: string; id: string } {
        let provider = String(entry.provider || groupProvider || '');
        let id = String(entry.id || entry.name || '');
        const slash = id.indexOf('/');
        if (slash > 0) {
            const prefix = id.slice(0, slash);
            const rest = id.slice(slash + 1);
            if (!provider || provider === prefix || this.isKnownProviderPrefix(prefix)) {
                provider = prefix;
                id = rest;
            }
        }
        return { provider, id };
    }

    private isKnownProviderPrefix(provider: string): boolean {
        return /^(openai|openai-codex|codex|anthropic|deepseek|xiaomi|ollama|openrouter)$/i.test(provider);
    }

    private hasReasoningVocabulary(entry: ModelEntry): boolean {
        const efforts = entry.supportedReasoningEfforts
            ?? entry.compat?.supportedReasoningEfforts;
        const effortMap = entry.reasoningEffortMap
            ?? entry.thinkingLevelMap
            ?? entry.compat?.reasoningEffortMap;
        return (Array.isArray(entry.thinkingLevels) && entry.thinkingLevels.length > 0)
            || (Array.isArray(entry.thinkingOptions) && entry.thinkingOptions.length > 0)
            || (Array.isArray(efforts) && efforts.length > 0)
            || (!!effortMap && typeof effortMap === 'object' && Object.keys(effortMap).length > 0);
    }

    private isKnownReasoningFamily(provider: string, id: string, fullId?: string): boolean {
        const p = provider.toLowerCase();
        const name = (fullId || (provider ? `${provider}/${id}` : id)).toLowerCase();
        return /^(openai|openai-codex|codex)$/.test(p)
            && /(^|\/)(gpt-5|gpt-codex|codex|o[134])/i.test(name);
    }

    /**
     * Resolve the reasoning levels for a SINGLE model — only that model's own
     * advertised vocabulary. No global/agent union fallback (that was the bug:
     * every reasoning model showed an identical generic list). If the model
     * advertises nothing, returns [] and the submenu is hidden.
     */
    private getThinkingLevels(
        entry: ModelEntry,
        configThinking?: AgentThinkingSource,
    ): Array<{ id: string; label?: string }> {
        // 1. Explicit structured levels
        if (Array.isArray(entry.thinkingLevels) && entry.thinkingLevels.length) {
            return entry.thinkingLevels
                .map((level) => ({ id: String(level.id), label: level.label ? String(level.label) : undefined }))
                .filter((level) => level.id);
        }
        if (Array.isArray(entry.thinkingOptions) && entry.thinkingOptions.length) {
            return entry.thinkingOptions
                .map((label) => ({ id: String(label).toLowerCase().replace(/\s+/g, '-'), label: String(label) }))
                .filter((level) => level.id);
        }

        // 2. Per-model reasoning vocabulary (the model's lingua franca)
        const efforts = entry.supportedReasoningEfforts
            ?? entry.compat?.supportedReasoningEfforts;
        if (Array.isArray(efforts) && efforts.length) {
            return efforts.map((e) => ({ id: String(e), label: String(e) })).filter((l) => l.id);
        }
        const effortMap = entry.reasoningEffortMap ?? entry.thinkingLevelMap ?? entry.compat?.reasoningEffortMap;
        if (effortMap && typeof effortMap === 'object') {
            const keys = Object.keys(effortMap);
            if (keys.length) return keys.map((k) => ({ id: k, label: k }));
        }

        // 3. Per-model config override from openclaw.json (keyed by model id)
        if (configThinking?.levels.length) return configThinking.levels;

        // 4. Always-on fallback: a reasoning model with no advertised named-effort
        // enum (e.g. xiaomi/deepseek/ollama) uses OpenClaw's canonical levels — its
        // lingua franca. Selection is forced per-request; the gateway coerces to the
        // model's nearest supported value. getThinkingLevels is only called for
        // reasoning models, so the submenu is never empty for them.
        return OPENCLAW_THINKING_LEVELS.map((id) => ({ id, label: id }));
    }

    private readConfigThinkingSources(): Map<string, AgentThinkingSource> {
        const out = new Map<string, AgentThinkingSource>();
        const paths = [getOpenClawConfigPath()].filter(Boolean);
        for (const filePath of paths) {
            try {
                if (!fs.existsSync(filePath)) continue;
                const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const providers = raw?.models?.providers;
                if (!providers || typeof providers !== 'object') continue;
                for (const [providerId, provider] of Object.entries(providers as Record<string, any>)) {
                    const models = Array.isArray(provider?.models) ? provider.models : [];
                    for (const model of models) {
                        const id = String(model?.id ?? model?.name ?? '');
                        if (!id) continue;
                        const levels = this.levelsFromUnknown(
                            model.supportedReasoningEfforts
                            ?? model?.compat?.supportedReasoningEfforts
                            ?? model.thinkingLevels
                            ?? model.thinkingOptions
                            ?? model.reasoningEffortMap
                            ?? model?.compat?.reasoningEffortMap
                            ?? model.thinkingLevelMap
                            ?? model?.params?.thinking?.levels
                        );
                        const defaultLevel = typeof model.thinkingDefault === 'string'
                            ? model.thinkingDefault
                            : typeof model?.params?.thinking?.level === 'string'
                                ? model.params.thinking.level
                                : undefined;
                        if (levels.length || defaultLevel) {
                            out.set(`${providerId}/${id}`, { levels, defaultLevel });
                            out.set(id, { levels, defaultLevel });
                        }
                    }
                }
            } catch (error) {
                this.logger.warn('Could not read OpenClaw model thinking config', { path: filePath, error: String(error) });
            }
        }
        return out;
    }

    private levelsFromUnknown(value: any): Array<{ id: string; label?: string }> {
        if (Array.isArray(value)) {
            return value
                .map((level): { id: string; label?: string } | null => {
                    if (typeof level === 'string') return { id: level, label: level };
                    if (level && typeof level.id === 'string') return { id: level.id, label: typeof level.label === 'string' ? level.label : level.id };
                    return null;
                })
                .filter((level): level is { id: string; label?: string } => !!level?.id);
        }
        if (value && typeof value === 'object') {
            return Object.keys(value)
                .filter((key) => value[key] !== undefined && value[key] !== false)
                .map((key) => ({ id: key, label: key }));
        }
        return [];
    }
}
