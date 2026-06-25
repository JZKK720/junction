import { BridgeSelectionState, ModelChoice } from '../types';
import {
    modelChoiceDisplay,
    parseProviderModelChoice,
    selectedThinking,
    SelectedModelChoice,
    staticReasoningModelChoices,
} from '../modelPicker';

const SOUVERAINE_MODELS = ['openai/kimi-k2.6', 'openai/deepseek-v4-pro'];

export function listSouveraineModelChoices(
    selectedModel?: string,
    selectedThinking?: string,
): ModelChoice[] {
    return staticReasoningModelChoices(SOUVERAINE_MODELS, selectedModel, selectedThinking);
}

export function selectSouveraineModelChoice(
    data: any,
    selection: BridgeSelectionState,
): SelectedModelChoice | null {
    const parsed = parseProviderModelChoice(data);
    if (!parsed) return null;
    const thinking = selectedThinking(data, selection);
    return {
        display: modelChoiceDisplay(data, parsed.model),
        modelId: parsed.modelId,
        thinking,
    };
}
