import { jsonRequest } from '../http';
import { BridgeSelectionState, ModelChoice } from '../types';
import {
    modelChoiceDisplay,
    parseProviderModelChoice,
    reasoningChildren,
    selectedThinking,
    SelectedModelChoice,
} from '../modelPicker';
import { Logger } from '../../utils/logger';

async function loadOpenCodeV2Models(baseUrl: string): Promise<any[] | null> {
    const root = baseUrl.replace(/\/$/, '');
    try {
        const res: any = await jsonRequest(`${root}/api/model`, { timeoutMs: 4000 });
        if (Array.isArray(res?.data)) return res.data;
    } catch {}
    return null;
}

async function loadLegacyProviderModels(baseUrl: string): Promise<any[]> {
    const root = baseUrl.replace(/\/$/, '');
    const res: any = await jsonRequest(`${root}/provider`, { timeoutMs: 4000 });
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res?.all)) return res.all;
    if (Array.isArray(res?.providers)) return res.providers;
    return [];
}

function groupV2Models(models: any[], selectedModel?: string, selectedThinking?: string): ModelChoice[] {
    const groups = new Map<string, ModelChoice[]>();
    const providerNames = new Map<string, string>();
    for (const m of models) {
        if (m?.enabled === false) continue;
        const provider = String(m?.providerID || '').trim();
        const model = String(m?.id || '').trim();
        if (!provider || !model) continue;
        providerNames.set(provider, provider);
        const id = `${provider}/${model}`;
        const reasoning = !!m?.reasoning || !!m?.capabilities?.reasoning;
        const choice: ModelChoice = {
            id,
            label: m.name || model,
            description: provider,
            provider,
            model,
            supportsReasoning: reasoning,
            icon: 'lightbulb',
            checked: selectedModel === id,
        };
        if (reasoning) choice.children = reasoningChildren(id, selectedModel, selectedThinking);
        const children = groups.get(provider) ?? [];
        children.push(choice);
        groups.set(provider, children);
    }
    return Array.from(groups.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([provider, children]) => {
            children.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
            const checked = children.some((item) => item.checked || item.children?.some((child) => child.checked));
            return {
                id: `provider:${provider}`,
                label: providerNames.get(provider) || provider,
                description: `${children.length} model${children.length === 1 ? '' : 's'}`,
                provider,
                icon: 'database',
                checked,
                children,
            };
        });
}

function groupLegacyProviders(providers: any[], selectedModel?: string, selectedThinking?: string): ModelChoice[] {
    const choices: ModelChoice[] = [];
    for (const provider of providers) {
        const models = provider.models || {};
        const children: ModelChoice[] = [];
        for (const key of Object.keys(models)) {
            const m = models[key];
            const id = `${provider.id}/${m.id || key}`;
            const reasoning = !!m.reasoning;
            const choice: ModelChoice = {
                id,
                label: m.name || m.id || key,
                description: provider.name || provider.id,
                provider: provider.id,
                model: m.id || key,
                supportsReasoning: reasoning,
                icon: 'lightbulb',
                checked: selectedModel === id,
            };
            if (reasoning) choice.children = reasoningChildren(id, selectedModel, selectedThinking);
            children.push(choice);
        }
        if (children.length) {
            const checked = children.some((item) => item.checked || item.children?.some((child) => child.checked));
            choices.push({
                id: `provider:${provider.id}`,
                label: provider.name || provider.id,
                description: `${children.length} model${children.length === 1 ? '' : 's'}`,
                provider: provider.id,
                icon: 'database',
                checked,
                children,
            });
        }
    }
    return choices;
}

export async function listOpenCodeModelChoices(
    baseUrl: string,
    selectedModel?: string,
    selectedThinking?: string,
): Promise<ModelChoice[]> {
    try {
        const v2Models = await loadOpenCodeV2Models(baseUrl);
        if (v2Models) return groupV2Models(v2Models, selectedModel, selectedThinking);
        return groupLegacyProviders(await loadLegacyProviderModels(baseUrl), selectedModel, selectedThinking);
    } catch (err) {
        Logger.getInstance().error('opencode listModelChoices failed', err);
        return [];
    }
}

function providerId(choice: ModelChoice): string {
    if (choice.provider) return String(choice.provider);
    if (choice.id.startsWith('provider:')) return choice.id.slice('provider:'.length);
    const slash = choice.id.indexOf('/');
    return slash > 0 ? choice.id.slice(0, slash) : '';
}

export function organizeOpenCodeModelChoices(
    liveChoices: ModelChoice[],
    configuredProviderIds: Iterable<string> = [],
): ModelChoice[] {
    const configured = new Set(Array.from(configuredProviderIds).filter(Boolean));
    const primary: ModelChoice[] = [];
    const unconfigured: ModelChoice[] = [];

    for (const choice of liveChoices) {
        const id = providerId(choice);
        if (configured.has(id)) primary.push(choice);
        else unconfigured.push(choice);
    }

    primary.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
    unconfigured.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));

    if (!unconfigured.length) return primary;
    const checked = unconfigured.some((item) => {
        if (item.checked) return true;
        return !!item.children?.some((child) => child.checked || child.children?.some((grandchild) => grandchild.checked));
    });

    return [
        ...primary,
        {
            id: 'opencode:unconfigured-providers',
            label: 'Unconfigured providers',
            description: `${unconfigured.length} provider${unconfigured.length === 1 ? '' : 's'}`,
            icon: 'extensions',
            checked,
            children: unconfigured,
        },
    ];
}

export function selectOpenCodeModelChoice(
    data: any,
    selection: BridgeSelectionState,
): SelectedModelChoice | null {
    const parsed = parseProviderModelChoice(data, {
        stripThinkingSuffix: true,
    });
    if (!parsed) return null;
    const fallbackModelId = String(data.id ?? parsed.model).replace(/:thinking:.*$/, '');
    const modelId = parsed.provider ? parsed.modelId : fallbackModelId;
    const thinking = selectedThinking(data, selection);
    return {
        display: modelChoiceDisplay(data, parsed.model),
        modelId,
        thinking,
    };
}
