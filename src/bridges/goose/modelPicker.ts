import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BridgeSelectionState, ModelChoice, OPENCLAW_THINKING_LEVELS } from '../types';
import {
    modelChoiceDisplay,
    parseProviderModelChoice,
    reasoningChildren,
    selectedThinking,
    SelectedModelChoice,
} from '../modelPicker';

const execFileAsync = promisify(execFile);

export async function listGooseModelChoices(
    configHome: string,
    dataHome: string,
    selectedModel?: string,
    selectedThinking?: string,
): Promise<ModelChoice[]> {
    const configured = readConfiguredModel(configHome);
    const customModels = readCustomProviderModels(configHome);
    const customProviders = new Set(customModels.map((item) => item.provider));
    const dbInventory = await readProviderInventory(dataHome).catch(() => []);
    const inventory = [
        ...customModels,
        ...dbInventory.filter((item) => !customProviders.has(item.provider)),
    ];
    const choices: ModelChoice[] = [];
    const seen = new Set<string>();

    for (const item of inventory) {
        const id = `${item.provider}/${item.model}`;
        if (seen.has(id)) continue;
        seen.add(id);
        choices.push({
            id,
            label: item.model,
            description: item.provider,
            provider: item.provider,
            model: item.model,
            supportsReasoning: item.reasoning,
            icon: item.reasoning ? 'lightbulb' : 'symbol-method',
            checked: selectedModel === id || (!selectedModel && configured.id === id),
            children: item.reasoning ? reasoningChildren(id, selectedModel ?? configured.id, selectedThinking) : undefined,
        });
    }

    if (configured.id && !choices.some((c) => c.id === configured.id)) {
        const reasoning = true;
        choices.unshift({
            id: configured.id,
            label: configured.model,
            description: configured.provider,
            provider: configured.provider,
            model: configured.model,
            supportsReasoning: reasoning,
            icon: 'lightbulb',
            checked: selectedModel === configured.id || !selectedModel,
            children: reasoningChildren(configured.id, selectedModel ?? configured.id, selectedThinking),
        });
    }

    return choices;
}

export function selectGooseModelChoice(
    data: any,
    selection: BridgeSelectionState,
): SelectedModelChoice | null {
    const parsed = parseProviderModelChoice(data, {
        stripProviderFromModel: true,
        stripThinkingSuffix: true,
    });
    if (!parsed) return null;
    const thinking = selectedThinking(data, selection);
    return {
        display: modelChoiceDisplay(data, parsed.model),
        modelId: parsed.modelId,
        thinking: thinking && OPENCLAW_THINKING_LEVELS.includes(thinking) ? thinking : undefined,
    };
}

function readConfiguredModel(configHome: string): { id: string; provider: string; model: string } {
    const configPath = path.join(configHome, 'config.yaml');
    try {
        const text = fs.readFileSync(configPath, 'utf8');
        const provider = readYamlScalar(text, 'GOOSE_PROVIDER') || readYamlScalar(text, 'active_provider') || '';
        const model = readYamlScalar(text, 'GOOSE_MODEL') || readNestedModel(text, provider) || '';
        return { id: provider && model ? `${provider}/${model}` : '', provider, model };
    } catch {
        return { id: '', provider: '', model: '' };
    }
}

function readYamlScalar(text: string, key: string): string {
    const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*["']?([^"'\\n#]+)`, 'm'));
    return match ? match[1].trim() : '';
}

function readNestedModel(text: string, provider: string): string {
    if (!provider) return '';
    const re = new RegExp(`^\\s{2}${escapeRegExp(provider)}:\\s*\\n([\\s\\S]*?)(?=^\\s{2}\\S|^\\S|$)`, 'm');
    const match = text.match(re);
    const model = match?.[1]?.match(/^\s+model:\s*["']?([^"'\n#]+)/m);
    return model ? model[1].trim() : '';
}

async function readProviderInventory(dataHome: string): Promise<Array<{ provider: string; model: string; reasoning: boolean }>> {
    const db = path.join(dataHome, 'sessions', 'sessions.db');
    if (!fs.existsSync(db)) return [];
    const sql = [
        'SELECT e.provider_id, m.model_id, COALESCE(m.reasoning, 0)',
        'FROM provider_inventory_entries e',
        'JOIN provider_inventory_models m ON m.inventory_key = e.inventory_key',
        'ORDER BY e.provider_id, m.ordinal;',
    ].join(' ');
    const { stdout } = await execFileAsync('sqlite3', [db, sql], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    return String(stdout).split(/\r?\n/).map((line) => {
        const [provider, model, reasoning] = line.split('|');
        return provider && model ? { provider, model, reasoning: reasoning === '1' || reasoning === 'true' } : null;
    }).filter(Boolean) as Array<{ provider: string; model: string; reasoning: boolean }>;
}

function readCustomProviderModels(configHome: string): Array<{ provider: string; model: string; reasoning: boolean }> {
    const dir = path.join(configHome, 'custom_providers');
    if (!fs.existsSync(dir)) return [];
    const out: Array<{ provider: string; model: string; reasoning: boolean }> = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            const provider = String(data.name || path.basename(file, '.json'));
            const models = Array.isArray(data.models) ? data.models : [];
            for (const model of models) {
                const name = typeof model === 'string' ? model : String(model?.name || '');
                if (!name) continue;
                out.push({ provider, model: name, reasoning: model?.reasoning !== false });
            }
        } catch {
            // Ignore malformed custom provider files; Goose itself reports them.
        }
    }
    return out;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
