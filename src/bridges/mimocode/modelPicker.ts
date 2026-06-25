import { BridgeSelectionState, ModelChoice } from '../types';
import {
    modelChoiceDisplay,
    parseProviderModelChoice,
    reasoningChildren,
    selectedThinking,
    SelectedModelChoice,
} from '../modelPicker';

const MIMOCODE_NATIVE_PROVIDER_ORDER = [
    'xiaomi',
    'mimo',
];

const MIMOCODE_NATIVE_PROVIDERS = new Set(MIMOCODE_NATIVE_PROVIDER_ORDER);

const DEFAULT_MIMOCODE_MODEL = 'mimo/mimo-auto';

function providerId(choice: ModelChoice): string {
    if (choice.provider) return String(choice.provider);
    if (choice.id.startsWith('provider:')) return choice.id.slice('provider:'.length);
    const slash = choice.id.indexOf('/');
    return slash > 0 ? choice.id.slice(0, slash) : '';
}

function providerSort(a: ModelChoice, b: ModelChoice): number {
    const aId = providerId(a);
    const bId = providerId(b);
    const aIndex = MIMOCODE_NATIVE_PROVIDER_ORDER.indexOf(aId);
    const bIndex = MIMOCODE_NATIVE_PROVIDER_ORDER.indexOf(bId);
    if (aIndex !== -1 || bIndex !== -1) {
        return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    }
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
}

function normalizeNativeProvider(choice: ModelChoice): ModelChoice {
    const id = providerId(choice);
    if (id === 'xiaomi') {
        return { ...choice, label: 'MiMo+', description: choice.description || 'MiMo models' };
    }
    if (id === 'mimo') {
        return { ...choice, label: 'MiMo Auto', description: choice.description || 'Free auto routing' };
    }
    return choice;
}

function modelChoice(
    provider: string,
    model: string,
    label: string,
    selectedModel?: string,
    selectedThinking?: string,
): ModelChoice {
    const id = `${provider}/${model}`;
    const selected = !selectedModel ? id === DEFAULT_MIMOCODE_MODEL : (selectedModel === id || selectedModel === model);
    return {
        id,
        label,
        provider,
        model,
        supportsReasoning: true,
        icon: 'lightbulb',
        checked: selected,
        children: reasoningChildren(id, selectedModel, selectedThinking),
    };
}

export function listMiMoCodeModelChoices(
    selectedModel?: string,
    selectedThinking?: string,
): ModelChoice[] {
    const auto = modelChoice('mimo', 'mimo-auto', 'MiMo Auto', selectedModel, selectedThinking);
    const plus = modelChoice('xiaomi', 'mimo-v2.5-pro', 'MiMo-V2.5-Pro', selectedModel, selectedThinking);
    return [
        {
            id: 'provider:xiaomi',
            label: 'MiMo+',
            description: '1 model',
            provider: 'xiaomi',
            icon: 'database',
            checked: !!plus.checked || !!plus.children?.some((child) => child.checked),
            children: [plus],
        },
        {
            id: 'provider:mimo',
            label: 'MiMo Auto',
            description: '1 model',
            provider: 'mimo',
            icon: 'database',
            checked: !!auto.checked || !!auto.children?.some((child) => child.checked),
            children: [auto],
        },
    ];
}

export function organizeMiMoCodeModelChoices(
    liveChoices: ModelChoice[],
    manualProviderIds: Iterable<string> = [],
): ModelChoice[] {
    const manual = new Set(Array.from(manualProviderIds).filter(Boolean));
    const primary: ModelChoice[] = [];
    const compatibility: ModelChoice[] = [];

    for (const choice of liveChoices) {
        const id = providerId(choice);
        if (MIMOCODE_NATIVE_PROVIDERS.has(id) || manual.has(id)) {
            primary.push(normalizeNativeProvider(choice));
        } else {
            compatibility.push(choice);
        }
    }

    const sortedPrimary = primary.sort(providerSort);
    if (!compatibility.length) return sortedPrimary;

    const compatibilityChecked = compatibility.some((item) => {
        if (item.checked) return true;
        return !!item.children?.some((child) => child.checked || child.children?.some((grandchild) => grandchild.checked));
    });

    return [
        ...sortedPrimary,
        {
            id: 'mimocode:opencode-compatibility',
            label: 'OpenCode compatibility',
            description: `${compatibility.length} provider${compatibility.length === 1 ? '' : 's'}`,
            icon: 'extensions',
            checked: compatibilityChecked,
            children: compatibility,
        },
    ];
}

export function selectMiMoCodeModelChoice(
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
