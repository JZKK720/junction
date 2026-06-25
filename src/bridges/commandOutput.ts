import { t } from '../l10n';

export type CommandOutputBlock =
    | { type: 'text'; text: string }
    | { type: 'error'; title?: string; text: string }
    | { type: 'keyValue'; title?: string; rows: Array<{ key: string; value: string }> }
    | { type: 'table'; title?: string; columns: string[]; rows: string[][] }
    | { type: 'sections'; title?: string; sections: Array<{ title: string; text?: string; rows?: Array<{ key: string; value: string }> }> };

export interface CommandOutputPayload {
    command: string;
    title?: string;
    blocks: CommandOutputBlock[];
}

export function stripAnsi(input: string): string {
    return String(input || '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '');
}

export function commandOutputToMarkdown(payload: CommandOutputPayload): string {
    const out: string[] = [];
    const title = payload.title || payload.command;
    if (title) out.push(`### ${title}`);
    for (const block of payload.blocks || []) {
        if (block.type === 'text') {
            if (block.text.trim()) out.push(block.text.trim());
            continue;
        }
        if (block.type === 'error') {
            out.push(`**${block.title || t('Error')}**\n\n${block.text.trim()}`);
            continue;
        }
        if (block.type === 'keyValue') {
            if (block.title) out.push(`**${block.title}**`);
            out.push(...block.rows.map((row) => `- **${row.key}:** ${row.value}`));
            continue;
        }
        if (block.type === 'sections') {
            if (block.title) out.push(`**${block.title}**`);
            for (const section of block.sections) {
                out.push(`**${section.title}**`);
                if (section.text) out.push(section.text);
                if (section.rows?.length) out.push(...section.rows.map((row) => `- **${row.key}:** ${row.value}`));
            }
            continue;
        }
        if (block.type === 'table') {
            if (block.title) out.push(`**${block.title}**`);
            const cols = block.columns.length ? block.columns : ['Name', 'Value'];
            out.push(`| ${cols.join(' | ')} |`);
            out.push(`| ${cols.map(() => '---').join(' | ')} |`);
            for (const row of block.rows) {
                out.push(`| ${cols.map((_, i) => escapeMdCell(row[i] || '')).join(' | ')} |`);
            }
        }
    }
    return out.filter(Boolean).join('\n\n');
}

export function parseHermesCommandOutput(command: string, raw: string): CommandOutputPayload | null {
    const name = normalizeCommandName(command);
    const text = stripAnsi(raw).trim();
    if (!text) return null;
    if (/^warning:/i.test(text) || /^error:/i.test(text)) {
        return { command: `/${name}`, title: `/${name}`, blocks: [{ type: 'error', text }] };
    }

    const boxed = unboxText(text);
    const commandRows = parseCommandRows(boxed.lines);
    if (commandRows.length >= 3 && ['skills', 'tools', 'commands', 'help'].includes(name)) {
        return {
            command: `/${name}`,
            title: boxed.title || `/${name}`,
            blocks: [{
                type: 'table',
                title: boxed.heading,
                columns: ['Command', 'Description'],
                rows: commandRows,
            }],
        };
    }

    const kv = parseKeyValueRows(boxed.lines);
    if (kv.length >= 2 && ['status', 'config', 'model', 'models', 'reasoning'].includes(name)) {
        return { command: `/${name}`, title: boxed.title || `/${name}`, blocks: [{ type: 'keyValue', rows: kv }] };
    }

    const listRows = boxed.lines
        .map((line) => line.trim())
        .filter((line) => line && !isDecorativeLine(line))
        .map((line) => splitLooseColumns(line))
        .filter((row) => row.length >= 2);
    if (listRows.length >= 3 && ['sessions', 'agents'].includes(name)) {
        const width = Math.max(...listRows.map((row) => row.length));
        return {
            command: `/${name}`,
            title: boxed.title || `/${name}`,
            blocks: [{
                type: 'table',
                columns: Array.from({ length: width }, (_, i) => i === 0 ? 'ID' : i === 1 ? 'Name' : `Value ${i}`),
                rows: listRows.map((row) => Array.from({ length: width }, (_, i) => row[i] || '')),
            }],
        };
    }

    if (boxed.lines.some((line) => line !== text)) {
        return { command: `/${name}`, title: boxed.title || `/${name}`, blocks: [{ type: 'text', text: boxed.lines.join('\n').trim() }] };
    }
    return null;
}

export function parseGenericCommandOutput(command: string, raw: string): CommandOutputPayload | null {
    const text = stripAnsi(raw).trim();
    if (!text) return null;
    if (/^(error|failed|warning):/i.test(text)) {
        return buildErrorCommandOutput(command, text);
    }
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const kv = parseKeyValueRows(lines);
    if (kv.length >= 2) {
        return buildKeyValueCommandOutput(command, kv);
    }
    const rows = lines.map(splitLooseColumns).filter((row) => row.length >= 2);
    if (rows.length >= 2) {
        const width = Math.max(...rows.map((row) => row.length));
        return buildTableCommandOutput(
            command,
            Array.from({ length: width }, (_, i) => i === 0 ? 'Name' : `Value ${i}`),
            rows.map((row) => Array.from({ length: width }, (_, i) => row[i] || '')),
        );
    }
    return null;
}

export function buildKeyValueCommandOutput(command: string, rows: Array<{ key: string; value: string }>, title?: string): CommandOutputPayload {
    return { command, title: title || command, blocks: [{ type: 'keyValue', rows }] };
}

export function buildTableCommandOutput(command: string, columns: string[], rows: string[][], title?: string): CommandOutputPayload {
    return { command, title: title || command, blocks: [{ type: 'table', columns, rows }] };
}

export function buildErrorCommandOutput(command: string, text: string, title?: string): CommandOutputPayload {
    return { command, title: title || command, blocks: [{ type: 'error', text }] };
}

function escapeMdCell(value: string): string {
    return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function normalizeCommandName(command: string): string {
    return String(command || '').trim().replace(/^\//, '').split(/\s+/)[0] || 'command';
}

function unboxText(text: string): { title?: string; heading?: string; lines: string[] } {
    let title = '';
    let heading = '';
    const lines: string[] = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            lines.push('');
            continue;
        }
        const top = line.match(/^[╭┌]\S*[\s─━-]+(.+?)[\s─━-]*[╮┐]$/);
        if (top) {
            title = top[1].trim();
            continue;
        }
        if (isDecorativeLine(line)) continue;
        let cleaned = line.replace(/^[│┃]\s?/, '').replace(/\s?[│┃]$/, '').trimEnd();
        if (!cleaned.trim()) {
            lines.push('');
            continue;
        }
        const boldHeading = cleaned.match(/^(.+ Commands:|.+:)$/);
        if (!heading && boldHeading) {
            heading = boldHeading[1].trim();
            continue;
        }
        lines.push(cleaned.trim());
    }
    return { title, heading, lines: foldWrappedLines(lines) };
}

function isDecorativeLine(line: string): boolean {
    return /^[╭╮╰╯┌┐└┘│┃─━┬┴┼├┤\s-]+$/.test(line);
}

function foldWrappedLines(lines: string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        if (out.length && /^\S/.test(out[out.length - 1]) && /^\S/.test(line) === false) {
            out[out.length - 1] += ` ${line.trim()}`;
        } else if (out.length && !looksLikeCommandStart(line) && looksLikeCommandStart(out[out.length - 1])) {
            out[out.length - 1] += ` ${line.trim()}`;
        } else {
            out.push(line.trim());
        }
    }
    return out;
}

function looksLikeCommandStart(line: string): boolean {
    return /^[A-Za-z][\w.-]*(?:\s+(?:<[^>]+>|\[[^\]]+\]|--[\w-]+|\w+\|[\w|]+))*\s+.+/.test(line);
}

function parseCommandRows(lines: string[]): string[][] {
    const rows: string[][] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || isDecorativeLine(trimmed)) continue;
        const split = trimmed.match(/^(.+?)\s{2,}(.+)$/);
        if (split) {
            rows.push([split[1].trim(), split[2].trim()]);
            continue;
        }
        const loose = trimmed.match(/^([A-Za-z][\w.-]*(?:\s+(?:<[^>]+>|\[[^\]]+\]|--[\w-]+|\w+\|[\w|]+))*)\s+(.+)$/);
        if (loose) rows.push([loose[1].trim(), loose[2].trim()]);
    }
    return rows;
}

function parseKeyValueRows(lines: string[]): Array<{ key: string; value: string }> {
    const rows: Array<{ key: string; value: string }> = [];
    for (const line of lines) {
        const match = line.match(/^([^:=]{2,40})\s*[:=]\s*(.+)$/);
        if (match) rows.push({ key: match[1].trim(), value: match[2].trim() });
    }
    return rows;
}

function splitLooseColumns(line: string): string[] {
    return line.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);
}
