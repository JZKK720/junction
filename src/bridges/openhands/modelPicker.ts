import { jsonRequest } from '../http';
import { BridgeSelectionState, ModelChoice } from '../types';
import { modelChoiceDisplay, reasoningChildren, selectedThinking, SelectedModelChoice } from '../modelPicker';
import { Logger } from '../../utils/logger';

export async function listOpenHandsModelChoices(
    baseUrl: string,
    apiPrefix: string,
    selectedModel?: string,
    selectedThinking?: string,
): Promise<ModelChoice[]> {
    let models: any[] = [];
    try {
        const res: any = await jsonRequest(`${baseUrl}${apiPrefix}/config/models/search?limit=100`, { timeoutMs: 5000 });
        models = res?.items || res?.results || res?.models || (Array.isArray(res) ? res : []);
    } catch (err) {
        Logger.getInstance().error('openhands listModelChoices failed', err);
        return [];
    }

    const byProvider = new Map<string, ModelChoice[]>();
    for (const m of models) {
        const id = String(typeof m === 'string' ? m : (m.id || m.model || m.name));
        const slash = id.lastIndexOf('/');
        const provider = slash > 0 ? id.slice(0, slash) : (m.provider || '');
        const supportsReasoning = m.reasoning ?? m.supports_reasoning ?? true;
        const model = slash > 0 ? id.slice(slash + 1) : id;
        const choice: ModelChoice = {
            id,
            label: model,
            description: provider,
            provider,
            model,
            supportsReasoning: !!supportsReasoning,
            icon: 'lightbulb',
            checked: selectedModel === id,
        };
        if (supportsReasoning) {
            choice.children = reasoningChildren(id, selectedModel, selectedThinking);
        }
        byProvider.set(provider || 'default', [...(byProvider.get(provider || 'default') || []), choice]);
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

export function selectOpenHandsModelChoice(
    data: any,
    selection: BridgeSelectionState,
): SelectedModelChoice | null {
    const provider = String(data.provider || '');
    let modelId = String(data.model ?? data.id ?? '').replace(/:thinking:.*$/, '');
    if (provider && !modelId.startsWith(`${provider}/`)) modelId = `${provider}/${modelId}`;
    if (!modelId) return null;
    const thinking = selectedThinking(data, selection);
    return { display: modelChoiceDisplay(data, modelId.replace(/^.*\//, '')), modelId, thinking };
}
