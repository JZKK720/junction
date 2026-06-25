import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { getActiveBridge, setActiveBridge } from '../config/agentBridgeConfig';
import { ChatBridge, ChoiceMenuItem } from './types';
import { t } from '../l10n';

export class BridgeRegistry extends EventEmitter {
    private bridges = new Map<string, ChatBridge>();
    private activeId: string;
    private readonly configuredId: string;

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        this.configuredId = getActiveBridge();
        this.activeId = this.configuredId;
    }

    register(bridge: ChatBridge): void {
        this.bridges.set(bridge.id, bridge);
        if (bridge.id === this.configuredId) {
            // Configured bridge just became available — restore it.
            this.activeId = this.configuredId;
        } else if (!this.bridges.has(this.activeId)) {
            // Configured bridge not registered yet — use this as fallback.
            this.activeId = bridge.id;
        }
    }

    get active(): ChatBridge {
        const bridge = this.bridges.get(this.activeId) ?? this.bridges.values().next().value;
        if (!bridge) throw new Error('No agent bridges are registered');
        return bridge;
    }

    getAll(): ChatBridge[] {
        return [...this.bridges.values()];
    }

    async setActive(id: string): Promise<void> {
        if (!this.bridges.has(id)) throw new Error(`Unknown bridge: ${id}`);
        if (id === this.activeId) return;
        this.active.disconnect();
        this.activeId = id;
        await setActiveBridge(id);
        this.emit('changed', this.active);
        await this.active.connect().catch(() => false);
    }

    async connectActive(): Promise<boolean> {
        const ok = await this.active.connect();
        if (ok) await this.active.registerRuntimeIntegrations();
        return ok;
    }

    disconnectAll(): void {
        for (const bridge of this.bridges.values()) bridge.disconnect();
    }

    async listEnvironmentChoices(): Promise<ChoiceMenuItem[]> {
        const visible: ChoiceMenuItem[] = [];
        const disconnected: ChoiceMenuItem[] = [];
        for (const bridge of this.getAll()) {
            const children = await bridge.listEnvironmentChoices().catch((): ChoiceMenuItem[] => [{
                id: `${bridge.id}:configure`,
                label: t('Configure {0}', bridge.label),
                description: t('Bridge settings'),
                icon: 'gear',
                bridgeId: bridge.id,
            }]);
            const mappedChildren = children.map((item) => ({ ...item, bridgeId: item.bridgeId ?? bridge.id }));
            const isActive = bridge.id === this.active.id;
            const hasConfigured = children.some((c) => !c.setup);
            const item: ChoiceMenuItem = {
                id: `bridge:${bridge.id}`,
                label: bridge.label,
                description: isActive
                    ? t('Active bridge')
                    : (hasConfigured ? t('Switch bridge') : t('Disconnected; setup required')),
                section: t('Bridges'),
                icon: bridge.isConnected() ? 'hubot' : 'plug',
                checked: isActive,
                bridgeId: bridge.id,
                // Configured bridges: clicking the main area swaps straight to the
                // bridge (its last-used config); the chevron opens the agent/runtime
                // submenu. Unconfigured ones open the submenu (setup) on any click.
                parentSelectable: hasConfigured,
                children: mappedChildren,
            };
            if (isActive || hasConfigured) visible.push(item);
            else disconnected.push({ ...item, section: undefined });
        }
        if (disconnected.length) {
            visible.push({
                id: 'bridge:more',
                label: t('Disconnected bridges'),
                description: disconnected.length === 1 ? t('1 bridge') : t('{0} bridges', disconnected.length),
                section: t('Bridges'),
                icon: 'extensions',
                children: disconnected,
            });
        }
        return visible;
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        const id = String(data.id ?? '');
        const bridgeId = String(data.bridgeId ?? '').trim();
        if (id.startsWith('bridge:')) {
            const bridgeName = id.slice('bridge:'.length);
            if (bridgeName !== 'more') await this.setActive(bridgeName);
            return;
        }
        if (bridgeId && bridgeId !== this.active.id) {
            await this.setActive(bridgeId);
        }
        await this.active.selectEnvironmentChoice(data);
    }
}
