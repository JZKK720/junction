import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';
import * as fs from 'fs';
import { getOpenClawConfigPath } from '../config/agentBridgeConfig';
import {
    ModelEntry,
    ProviderGroup,
    ModelCatalogBrowseView,
} from '../types/openclaw';

/**
 * Internal cache structure — raw browse view + metadata
 */
interface ModelCache {
    providers: ProviderGroup[];
    timestamp: number;
    /** Flattened model list for menu lookups */
    flatModels: Map<string, ModelEntry>;
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
            const payload = await gateway.sendRequest('models.list', { view: 'default' });

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

            this.cache = {
                providers,
                timestamp: Date.now(),
                flatModels,
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

    async getModelChoices(gateway: GatewayConnection, selectedModel?: string, selectedThinking?: string, selectedAgentId?: string): Promise<ModelChoice[]> {
        const providers = await this.getModels(gateway);
        const agentThinking = await this.getAgentThinkingSource(gateway, selectedAgentId);
        const configThinking = this.readConfigThinkingSources();
        const items: ModelChoice[] = [];
        for (const group of providers) {
            for (const model of group.models) {
                const entry: ModelEntry = typeof model === 'object' ? model : { id: String(model), name: String(model) };
                const normalized = this.normalizeEntry(group.provider, entry);
                const caps = entry.capabilities;
                const supportsReasoning = entry.reasoning === true;
                const fullId = normalized.provider ? `${normalized.provider}/${normalized.id}` : normalized.id;
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
                        agentThinking,
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
            if (!provider || provider === prefix) {
                provider = prefix;
                id = rest;
            }
        }
        return { provider, id };
    }

    private getThinkingLevels(
        entry: ModelEntry,
        agentThinking: AgentThinkingSource,
        configThinking?: AgentThinkingSource,
    ): Array<{ id: string; label?: string }> {
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

        if (configThinking?.levels.length) return configThinking.levels;
        if (agentThinking.levels.length) return agentThinking.levels;
        if (configThinking?.defaultLevel) return [{ id: configThinking.defaultLevel, label: configThinking.defaultLevel }];
        if (agentThinking.defaultLevel) return [{ id: agentThinking.defaultLevel, label: agentThinking.defaultLevel }];
        return [];
    }

    private async getAgentThinkingSource(gateway: GatewayConnection, selectedAgentId?: string): Promise<AgentThinkingSource> {
        try {
            if (!gateway.capabilities.canListAgents()) return { levels: [] };
            const res = await gateway.sendRequest('agents.list', {});
            const agents = Array.isArray(res?.agents) ? res.agents : Array.isArray(res) ? res : [];
            const defaultId = String(res?.defaultId ?? '');
            const agent = agents.find((a: any) => {
                const id = String(a?.agentId ?? a?.id ?? '');
                return selectedAgentId ? id === selectedAgentId : id === defaultId;
            }) ?? agents[0];
            if (!agent) return { levels: [] };
            return {
                levels: this.levelsFromUnknown(agent.thinkingLevels ?? agent.thinkingOptions),
                defaultLevel: typeof agent.thinkingDefault === 'string' ? agent.thinkingDefault : undefined,
            };
        } catch (error) {
            this.logger.warn('agents.list unavailable for thinking levels', error);
            return { levels: [] };
        }
    }

    private readConfigThinkingSources(): Map<string, AgentThinkingSource> {
        const out = new Map<string, AgentThinkingSource>();
        const paths = [getOpenClawConfigPath(), '/home/e/entities/ling/openclaw.json'].filter(Boolean);
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
                        const levels = this.levelsFromUnknown(model.thinkingLevels ?? model.thinkingOptions ?? model.thinkingLevelMap ?? model?.params?.thinking?.levels);
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
