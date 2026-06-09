/**
 * agentConfig.ts — Agent request builder, model override, and run control.
 *
 * Provides:
 *   - buildAgentParams() — full payload for the `agent` method
 *   - setSessionModel() — persistent model override via sessions.patch (admin scope)
 *   - abortRun() / abortSession() / waitForRun() — run lifecycle control
 *   - listAgents() / getAgentIdentity() — agent discovery
 */

import * as crypto from 'crypto';
import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';

// ────────────────────────────────────────
// Types
// ────────────────────────────────────────

export interface AgentRequestConfig {
  agentId?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  attachments?: unknown[];
  deliver?: boolean;
  bootstrapContextMode?: 'lightweight' | 'full';
}

export interface AgentParams {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  agentId?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  attachments?: unknown[];
  deliver?: boolean;
  bootstrapContextMode?: string;
}

// ────────────────────────────────────────
// Agent request builder (T3)
// ────────────────────────────────────────

/**
 * Build the full `agent` method payload.
 *
 * Always includes `idempotencyKey` (REQUIRED by gateway).
 * Conditional fields are spread only when set.
 */
export function buildAgentParams(
  sessionKey: string,
  message: string,
  config: AgentRequestConfig = {},
): AgentParams {
  const params: AgentParams = {
    sessionKey,
    message,
    idempotencyKey: crypto.randomUUID(),
  };

  if (config.agentId) { params.agentId = config.agentId; }
  if (config.model) { params.model = config.model; }
  if (config.provider) { params.provider = config.provider; }
  if (config.thinking) { params.thinking = config.thinking; }
  if (config.attachments?.length) { params.attachments = config.attachments; }
  if (config.deliver !== undefined) { params.deliver = config.deliver; }
  if (config.bootstrapContextMode) { params.bootstrapContextMode = config.bootstrapContextMode; }

  return params;
}

// ────────────────────────────────────────
// Model override via sessions.patch (T2)
// ────────────────────────────────────────

/**
 * Apply a persistent model override to a session.
 *
 * **REQUIRES `operator.admin` scope.** If the connection token lacks admin,
 * this call will fail. Callers should fall back to per-request model via
 * `buildAgentParams` instead.
 *
 * @returns true if the patch succeeded, false if scope was insufficient.
 */
export async function setSessionModel(
  gateway: GatewayConnection,
  sessionKey: string,
  provider: string,
  model: string,
  thinking?: string | null,
): Promise<boolean> {
  const logger = Logger.getInstance();

  // Scope guard: sessions.patch requires operator.admin
  if (!gateway.authScopes.includes('operator.admin')) {
    logger.warn(
      'Cannot apply sessions.patch — token lacks operator.admin scope. ' +
      'Model override will be per-request only via buildAgentParams.'
    );
    return false;
  }

  try {
    await gateway.sendRequest('sessions.patch', {
      key: sessionKey,
      model: provider ? `${provider}/${model}` : model,
      ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
    });
    logger.info(`Session model patched: ${provider}/${model} on ${sessionKey}`);
    return true;
  } catch (error) {
    logger.warn('sessions.patch model override failed; per-request model will still be used', error);
    return false;
  }
}

// ────────────────────────────────────────
// Run control (T4)
// ────────────────────────────────────────

/**
 * Abort a specific in-flight run.
 * Requires `operator.write` scope.
 */
export async function abortRun(
  gateway: GatewayConnection,
  sessionKey: string,
  runId?: string,
): Promise<void> {
  try {
    await gateway.sendRequest('chat.abort', { sessionKey, runId });
    Logger.getInstance().info(`Run aborted: ${runId ?? 'current'} on ${sessionKey}`);
  } catch (error) {
    Logger.getInstance().error('chat.abort failed', error);
  }
}

/**
 * Abort ALL runs for a session.
 * Requires `operator.write` scope.
 */
export async function abortSession(
  gateway: GatewayConnection,
  sessionKey: string,
): Promise<void> {
  try {
    await gateway.sendRequest('sessions.abort', { key: sessionKey });
    Logger.getInstance().info(`Session aborted: ${sessionKey}`);
  } catch (error) {
    Logger.getInstance().error('sessions.abort failed', error);
  }
}

/**
 * Wait for a specific run to complete.
 * Requires `operator.write` scope (startup method).
 */
export async function waitForRun(
  gateway: GatewayConnection,
  runId: string,
): Promise<void> {
  try {
    await gateway.sendRequest('agent.wait', { runId });
  } catch (error) {
    Logger.getInstance().error('agent.wait failed', error);
  }
}

// ────────────────────────────────────────
// Agent discovery (T6, T7)
// ────────────────────────────────────────

export interface AgentEntry {
  agentId?: string;
  id?: string;
  name?: string;
  displayName?: string;
  emoji?: string;
}

/**
 * List all configured agents.
 * Requires `operator.read` scope.
 */
export async function listAgents(gateway: GatewayConnection): Promise<AgentEntry[]> {
  try {
    const res = await gateway.sendRequest('agents.list', {});
    return res?.agents ?? res ?? [];
  } catch (error) {
    Logger.getInstance().error('agents.list failed', error);
    return [];
  }
}

/**
 * Get identity details for a specific agent.
 * Requires `operator.read` scope.
 */
export async function getAgentIdentity(
  gateway: GatewayConnection,
  agentId: string,
): Promise<{ name: string; displayName?: string; emoji?: string } | null> {
  try {
    return await gateway.sendRequest('agent.identity.get', { agentId });
  } catch (error) {
    Logger.getInstance().error('agent.identity.get failed', error);
    return null;
  }
}
