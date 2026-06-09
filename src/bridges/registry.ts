import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { getActiveBridge, setActiveBridge } from '../config/agentBridgeConfig';
import { ChatBridge, ChoiceMenuItem } from './types';

export class BridgeRegistry extends EventEmitter {
    private bridges = new Map<string, ChatBridge>();
    private activeId: string;

    constructor(readonly context: vscode.ExtensionContext) {
        super();
        this.activeId = getActiveBridge();
    }

    register(bridge: ChatBridge): void {
        this.bridges.set(bridge.id, bridge);
        if (!this.bridges.has(this.activeId)) this.activeId = bridge.id;
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
        const bridgeItems: ChoiceMenuItem[] = [];
        for (const bridge of this.getAll()) {
            const children = await bridge.listEnvironmentChoices().catch((): ChoiceMenuItem[] => [{
                id: `${bridge.id}:configure`,
                label: `Configure ${bridge.label}`,
                description: 'Bridge settings',
                icon: 'gear',
                bridgeId: bridge.id,
            }]);
            bridgeItems.push({
                id: `bridge:${bridge.id}`,
                label: bridge.label,
                description: bridge.id === this.active.id ? 'Active bridge' : 'Switch bridge',
                section: 'Bridges',
                icon: bridge.id === 'openclaw' ? 'plug' : 'hubot',
                checked: bridge.id === this.active.id,
                bridgeId: bridge.id,
                children: children.map((item) => ({ ...item, bridgeId: item.bridgeId ?? bridge.id })),
            });
        }
        return bridgeItems;
    }

    async selectEnvironmentChoice(data: any): Promise<void> {
        const id = String(data.id ?? '');
        const bridgeId = String(data.bridgeId ?? '').trim();
        if (id.startsWith('bridge:')) {
            await this.setActive(id.slice('bridge:'.length));
            return;
        }
        if (bridgeId && bridgeId !== this.active.id) {
            await this.setActive(bridgeId);
        }
        await this.active.selectEnvironmentChoice(data);
    }
}
