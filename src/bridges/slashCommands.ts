export interface ParsedSlashCommand {
    raw: string;
    name: string;
    args: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    const raw = String(text || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    const match = raw.match(/^\/([A-Za-z][\w.-]*)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return {
        raw,
        name: match[1].toLowerCase(),
        args: String(match[2] || '').trim(),
    };
}

export function isSlashCommandText(text: string): boolean {
    return parseSlashCommand(text) !== null;
}

export function slashRunId(bridgeId: string, name: string): string {
    return `${bridgeId}:slash:${name}:${Date.now()}`;
}
