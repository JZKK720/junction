import { ChoiceMenuItem } from './types';

export interface SandboxControlProfile {
    title: string;
    sandboxSection: string;
    approvalSection: string;
    sandboxModes: Array<{ value: string; label: string; icon: string; description?: string }>;
    approvalModes: Array<{ value: string; label: string; icon: string; description?: string }>;
}

const DEFAULT_PROFILE: SandboxControlProfile = {
    title: 'Sandbox / approvals',
    sandboxSection: 'Sandbox',
    approvalSection: 'Approvals',
    sandboxModes: [
        { value: 'default', label: 'Sandbox default', icon: 'settings' },
        { value: 'readonly', label: 'Read only', icon: 'lock' },
        { value: 'workspace-write', label: 'Workspace write', icon: 'edit' },
        { value: 'full-access', label: 'Full access', icon: 'unlock' },
    ],
    approvalModes: [
        { value: 'default', label: 'Approval default', icon: 'settings' },
        { value: 'ask', label: 'Ask', icon: 'question' },
        { value: 'never', label: 'Never', icon: 'check' },
    ],
};

const HERMES_PROFILE: SandboxControlProfile = {
    title: 'Hermes approvals',
    sandboxSection: 'Hermes runtime',
    approvalSection: 'Hermes approvals',
    sandboxModes: [
        { value: 'default', label: 'Hermes default', icon: 'settings', description: 'Use Hermes runtime sandbox defaults' },
    ],
    approvalModes: [
        { value: 'default', label: 'Hermes default', icon: 'settings', description: 'Use configured approvals.mode' },
        { value: 'ask', label: 'Ask', icon: 'question', description: 'Keep Hermes approval prompts enabled' },
        { value: 'never', label: 'YOLO', icon: 'warning', description: 'Toggle Hermes /yolo for this session' },
    ],
};

const GOOSE_PROFILE: SandboxControlProfile = {
    title: 'goose permissions',
    sandboxSection: 'goose runtime',
    approvalSection: 'goose prompts',
    sandboxModes: [
        { value: 'default', label: 'goose default', icon: 'symbol-method', description: 'Use native goose CLI runtime behavior' },
    ],
    approvalModes: [
        { value: 'default', label: 'goose default', icon: 'comment-discussion', description: 'Let goose handle tool prompts natively' },
    ],
};

const PROFILES: Record<string, SandboxControlProfile> = {
    openclaw: DEFAULT_PROFILE,
    hermes: HERMES_PROFILE,
    goose: GOOSE_PROFILE,
};

export function getSandboxControlProfile(bridgeId: string): SandboxControlProfile {
    return PROFILES[bridgeId] ?? DEFAULT_PROFILE;
}

export function normalizeSandboxControlSelection(bridgeId: string, sandbox: string, approval: string): { sandbox: string; approval: string } {
    const profile = getSandboxControlProfile(bridgeId);
    const sandboxOk = profile.sandboxModes.some((mode) => mode.value === sandbox);
    const approvalOk = profile.approvalModes.some((mode) => mode.value === approval);
    return {
        sandbox: sandboxOk ? sandbox : (profile.sandboxModes[0]?.value ?? 'default'),
        approval: approvalOk ? approval : (profile.approvalModes[0]?.value ?? 'default'),
    };
}

export function buildSandboxChoiceItems(bridgeId: string, sandbox: string, approval: string): ChoiceMenuItem[] {
    const profile = getSandboxControlProfile(bridgeId);
    const normalized = normalizeSandboxControlSelection(bridgeId, sandbox, approval);
    return [
        ...profile.sandboxModes.map((mode) => ({
            id: `sandbox:${mode.value}`,
            label: mode.label,
            description: mode.description,
            section: profile.sandboxSection,
            icon: mode.icon,
            checked: normalized.sandbox === mode.value,
            sandboxMode: mode.value,
        })),
        ...profile.approvalModes.map((mode) => ({
            id: `approval:${mode.value}`,
            label: mode.label,
            description: mode.description,
            section: profile.approvalSection,
            icon: mode.icon,
            checked: normalized.approval === mode.value,
            approvalMode: mode.value,
        })),
    ];
}

export function sandboxControlDescription(bridgeId: string, sandbox: string, approval: string): string {
    const profile = getSandboxControlProfile(bridgeId);
    const normalized = normalizeSandboxControlSelection(bridgeId, sandbox, approval);
    const sandboxLabel = profile.sandboxModes.find((mode) => mode.value === normalized.sandbox)?.label ?? normalized.sandbox;
    const approvalLabel = profile.approvalModes.find((mode) => mode.value === normalized.approval)?.label ?? normalized.approval;
    return `${profile.title}: ${sandboxLabel} / ${approvalLabel}`;
}
