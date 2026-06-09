/**
 * commandPalette.ts — Gateway slash-command registry for the VSCode extension.
 *
 * Uses `commands.list` (operator.read) to fetch available agent commands,
 * then provides suggestions for the chat input's `/` completion.
 */

import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';

// ────────────────────────────────────────
// Types
// ────────────────────────────────────────

export interface CommandArg {
  name: string;
  description?: string;
  choices?: string[];
}

export interface GatewayCommand {
  name: string;
  description?: string;
  aliases?: string[];
  args: CommandArg[];
}

// ────────────────────────────────────────
// CommandPalette
// ────────────────────────────────────────

export class CommandPalette {
  private commands: GatewayCommand[] = [];
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Load commands from the gateway.
   * Call after hello-ok and on reconnect (invalidate first).
   *
   * @param gateway  Active GatewayConnection.
   * @param agentId  Which agent's commands to fetch (default: 'main').
   */
  async load(gateway: GatewayConnection, agentId: string = 'main'): Promise<void> {
    try {
      // Map 'main' to the actual default agentId if the gateway expects a different format
      const resolvedAgentId = agentId === 'main' ? 'main' : agentId;

      const res = await gateway.sendRequest('commands.list', { agentId: resolvedAgentId });
      // Response shape: { commands: CommandEntry[] }
      const raw: unknown[] = res?.commands ?? res ?? [];

      this.commands = raw.map(normalizeCommand).filter((c): c is GatewayCommand => !!c);
      this.logger.info(`Loaded ${this.commands.length} commands for agent ${resolvedAgentId}`);
    } catch (error) {
      this.logger.error('commands.list failed', error);
      this.commands = [];
    }
  }

  /**
   * Clear the command cache. Call on reconnect before re-loading.
   */
  invalidate(): void {
    this.commands = [];
  }

  /**
   * Get command suggestions for a prefix (without the leading `/`).
   * Matches against command name and aliases.
   */
  getSuggestions(prefix: string): GatewayCommand[] {
    const q = prefix.toLowerCase();
    if (!q) return [...this.commands];

    return this.commands.filter(
      (c) =>
        c.name.startsWith(q) ||
        c.aliases?.some((a) => a.startsWith(q)),
    );
  }

  /**
   * Return all loaded commands (for display in help panels, etc.).
   */
  getAll(): GatewayCommand[] {
    return [...this.commands];
  }
}

// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

interface RawCommand {
  name?: string;
  description?: string;
  aliases?: string[];
  args?: Array<{
    name?: string;
    description?: string;
    choices?: string[];
  }>;
}

function normalizeCommand(raw: unknown): GatewayCommand | null {
  const c = raw as RawCommand;
  if (!c?.name) return null;

  return {
    name: c.name,
    description: c.description,
    aliases: c.aliases ?? [],
    args: (c.args ?? []).map((a) => ({
      name: a.name ?? '',
      description: a.description,
      choices: a.choices ?? [],
    })),
  };
}
