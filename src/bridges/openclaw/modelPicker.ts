import { setSessionModel } from '../../gateway/agentConfig';
import { GatewayConnection } from '../../gateway/connection';
import { ModelManager } from '../../gateway/modelManager';
import { BridgeSelectionState, ModelChoice } from '../types';
import { modelChoiceDisplay, SelectedModelChoice } from '../modelPicker';

export async function listOpenClawModelChoices(
    gateway: GatewayConnection,
    modelManager: ModelManager,
    selectedModel?: string,
    selectedThinking?: string,
    selectedAgentId?: string,
): Promise<ModelChoice[]> {
    if (!gateway.capabilities.canListModels()) return [];
    return modelManager.getModelChoices(
        gateway,
        selectedModel,
        selectedThinking,
        selectedAgentId,
    ) as Promise<ModelChoice[]>;
}

export async function selectOpenClawModelChoice(
    gateway: GatewayConnection,
    data: any,
    selection: BridgeSelectionState,
    sessionKey?: string | null,
): Promise<SelectedModelChoice | null> {
    const provider = String(data.provider ?? '');
    const model = String(data.model ?? data.id ?? '').replace(/^.*:/, '');
    if (!model) return null;
    const supportsReasoning = data.supportsReasoning !== false;
    const selectedThinking = data.thinking !== undefined ? String(data.thinking).trim() : '';
    const modelId = provider ? `${provider}/${model}` : model;
    const thinking = supportsReasoning ? (selectedThinking || selection.thinking) : undefined;

    let perRequestOnly = false;
    if (sessionKey) {
        const ok = await setSessionModel(
            gateway,
            sessionKey,
            provider,
            model,
            supportsReasoning ? thinking : null,
        );
        perRequestOnly = !ok;
    }

    return {
        display: modelChoiceDisplay(data, model) + (perRequestOnly ? ' (per-request)' : ''),
        modelId,
        thinking,
        perRequestOnly,
    };
}
