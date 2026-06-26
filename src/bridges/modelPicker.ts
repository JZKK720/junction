import {
    BridgeSelectionState,
    ModelChoice,
    OPENCLAW_THINKING_LEVELS,
} from './types';

export interface SelectedModelChoice {
    display: string;
    modelId: string;
    thinking?: string;
    perRequestOnly?: boolean;
}

export function modelChoiceDisplay(data: any, model: string): string {
    // Thinking submenu rows use the thinking level as their label ("high").
    // The model chip must keep showing the model, with thinking rendered in the
    // separate reasoning slot.
    if (data?.thinking !== undefined) return model;
    return String(data?.label ?? model);
}

export function parseProviderModelChoice(data: any, options: {
    stripProviderFromModel?: boolean;
    stripThinkingSuffix?: boolean;
} = {}): { provider: string; model: string; modelId: string } | null {
    const provider = String(data.provider ?? '');
    let model = String(data.model ?? data.id ?? '');
    if (options.stripThinkingSuffix) model = model.replace(/:thinking:.*$/, '');
    if (options.stripProviderFromModel) model = model.replace(/^.*\//, '');
    if (provider && model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1);
    if (!model) return null;
    const modelId = provider ? `${provider}/${model}` : model;
    return { provider, model, modelId };
}

export function selectedThinking(data: any, selection: BridgeSelectionState): string | undefined {
    return data.thinking !== undefined ? String(data.thinking) : selection.thinking;
}

export function reasoningChildren(id: string, selectedModel?: string, selectedThinking?: string, levels?: string[]): ModelChoice[] {
    const slash = id.indexOf('/');
    const provider = slash > 0 ? id.slice(0, slash) : '';
    const model = slash > 0 ? id.slice(slash + 1) : id;
    const effectiveLevels = levels?.length ? levels : OPENCLAW_THINKING_LEVELS;
    return effectiveLevels.map((level) => ({
        id: `${id}:thinking:${level}`,
        label: level,
        icon: 'thinking',
        provider,
        model,
        thinking: level,
        checked: selectedThinking === level && selectedModel === id,
    }));
}

export function staticReasoningModelChoices(
    ids: string[],
    selectedModel?: string,
    selectedThinking?: string,
    defaultModelId?: string,
    levels?: string[],
): ModelChoice[] {
    return ids.map((id) => {
        const slash = id.indexOf('/');
        const provider = slash > 0 ? id.slice(0, slash) : '';
        const model = slash > 0 ? id.slice(slash + 1) : id;
        const selected = !selectedModel && defaultModelId
            ? id === defaultModelId
            : (selectedModel === id || selectedModel === model);
        return {
            id,
            label: model,
            description: provider,
            provider,
            model,
            supportsReasoning: true,
            icon: 'lightbulb',
            checked: selected,
            children: reasoningChildren(id, selectedModel, selectedThinking, levels),
        };
    });
}
