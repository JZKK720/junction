import * as vscode from 'vscode';

type Target = vscode.ConfigurationTarget.Global | vscode.ConfigurationTarget.Workspace | vscode.ConfigurationTarget.WorkspaceFolder;

const DEFAULT_OPENCLAW_GATEWAY_URL = 'ws://127.0.0.1:18789';

function expandHome(p: string): string {
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return `${process.env.HOME || '~'}${p.slice(1)}`;
    return p;
}

export function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction');
}

export function openclawConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.openclaw');
}

export function hermesConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.hermes');
}

export function souveraineConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.souveraine');
}

export function getActiveBridge(): string {
    return config().get<string>('activeBridge', 'openclaw') || 'openclaw';
}

export async function setActiveBridge(id: string, target: Target = vscode.ConfigurationTarget.Global): Promise<void> {
    await config().update('activeBridge', id, target);
}

export function getOpenClawGatewayUrl(): string {
    return openclawConfig().get<string>('gatewayUrl', DEFAULT_OPENCLAW_GATEWAY_URL);
}

export function getOpenClawConfigPath(): string {
    return openclawConfig().get<string>('configPath', '');
}

export async function updateOpenClawGateway(url: string, configPath: string): Promise<void> {
    const cfg = openclawConfig();
    await cfg.update('gatewayUrl', url, vscode.ConfigurationTarget.Global);
    await cfg.update('configPath', configPath, vscode.ConfigurationTarget.Global);
}

export async function updateHermesRuntime(values: {
    dashboardUrl?: string;
    wsUrl?: string;
    apiBaseUrl?: string;
    home?: string;
}): Promise<void> {
    const cfg = hermesConfig();
    if (values.dashboardUrl !== undefined) await cfg.update('dashboardUrl', values.dashboardUrl, vscode.ConfigurationTarget.Global);
    if (values.wsUrl !== undefined) await cfg.update('wsUrl', values.wsUrl, vscode.ConfigurationTarget.Global);
    if (values.apiBaseUrl !== undefined) await cfg.update('apiBaseUrl', values.apiBaseUrl, vscode.ConfigurationTarget.Global);
    if (values.home !== undefined) await cfg.update('home', values.home, vscode.ConfigurationTarget.Global);
}

export async function updateSouveraineRuntime(values: {
    baseUrl?: string;
    home?: string;
}): Promise<void> {
    const cfg = souveraineConfig();
    if (values.baseUrl !== undefined) await cfg.update('baseUrl', values.baseUrl, vscode.ConfigurationTarget.Global);
    if (values.home !== undefined) await cfg.update('home', values.home, vscode.ConfigurationTarget.Global);
}

export function getHermesBaseUrl(): string {
    return hermesConfig().get<string>('dashboardUrl', 'http://127.0.0.1:9119');
}

export function getHermesApiBaseUrl(): string {
    return hermesConfig().get<string>('apiBaseUrl', 'http://127.0.0.1:8642');
}

export function getHermesWsUrl(): string {
    return hermesConfig().get<string>('wsUrl', 'ws://127.0.0.1:9119/api/ws');
}

export function getHermesHome(): string {
    return expandHome(hermesConfig().get<string>('home', '~/.hermes-hermling'));
}

export function mimocodeConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('junction.mimocode');
}

export function getSouveraineBaseUrl(): string {
    return souveraineConfig().get<string>('baseUrl', 'http://127.0.0.1:8484');
}

export function getSouveraineHome(): string {
    return expandHome(souveraineConfig().get<string>('home', '~/.souveraine-souvieling-home'));
}

export function getMiMoCodeBinaryPath(): string {
    return mimocodeConfig().get<string>('binaryPath', 'mimo');
}

export function getMiMoCodeHome(): string {
    return expandHome(mimocodeConfig().get<string>('home', '~/.mimocode-junction'));
}

