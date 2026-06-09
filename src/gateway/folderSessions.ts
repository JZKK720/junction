import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';
import { SessionEntry } from '../types/openclaw';

// ──────────────────────────────────────────────
// T1: Deterministic folder root key
// ──────────────────────────────────────────────

/**
 * Compute a deterministic session key from a workspace folder URI.
 * SHA256 of folderUri.toString(), hex digest first 16 chars, prefixed
 * with "agent:main:vscode-" to pass gateway key validation.
 *
 * Example: folderRootKey(uri) → "agent:main:vscode-a1b2c3d4e5f6g7h8"
 */
export function folderRootKey(folderUri: vscode.Uri): string {
  const hash = crypto
    .createHash('sha256')
    .update(folderUri.toString())
    .digest('hex')
    .substring(0, 16);
  return `agent:main:vscode-${hash}`;
}

// ──────────────────────────────────────────────
// T2: Per-folder state shape + persistence
// ──────────────────────────────────────────────

const STATE_PREFIX = 'openclaw.sessions.';

export interface FolderSessionState {
  /** Deterministic root session key for this folder */
  rootKey: string;
  /** Child chat keys, newest last */
  chatKeys: string[];
  /** Currently active session key (may be root or a chat child) */
  activeKey: string;
}

function stateKey(folderUri: vscode.Uri): string {
  return `${STATE_PREFIX}${folderUri.toString()}`;
}

export function getSessionState(
  ctx: vscode.ExtensionContext,
  folderUri: vscode.Uri
): FolderSessionState | undefined {
  return ctx.workspaceState.get<FolderSessionState>(stateKey(folderUri));
}

export function saveSessionState(
  ctx: vscode.ExtensionContext,
  folderUri: vscode.Uri,
  state: FolderSessionState
): void {
  ctx.workspaceState.update(stateKey(folderUri), state);
}

export function clearSessionState(
  ctx: vscode.ExtensionContext,
  folderUri: vscode.Uri
): void {
  ctx.workspaceState.update(stateKey(folderUri), undefined);
}

// ──────────────────────────────────────────────
// T6: sessionToFolder map — populated at startup, updated by events
// ──────────────────────────────────────────────

/** Maps session keys (root + child) to their workspace folder URI */
export const sessionToFolder = new Map<string, vscode.Uri>();

export function isOwned(key: string): boolean {
  return sessionToFolder.has(key);
}

// ──────────────────────────────────────────────
// T3: Folder root lifecycle
// ──────────────────────────────────────────────

/**
 * Ensure a folder root session exists for the given workspace folder.
 * Call on extension activate (with each workspace folder) and on every
 * reconnect (via connection.on('reconnected', ...)).
 *
 * Returns the root session key.
 */
export async function ensureFolderSession(
  gateway: GatewayConnection,
  ctx: vscode.ExtensionContext,
  folderUri: vscode.Uri
): Promise<string> {
  const rootKey = folderRootKey(folderUri);
  const logger = Logger.getInstance();

  // CRITICAL: sessions.describe returns { session: SessionEntry | null }
  // even when the session doesn't exist. Check payload.session, NOT res.ok.
  const res = await gateway.sendRequest('sessions.describe', { key: rootKey });

  if (!res || !res.session) {
    logger.info(`Creating folder root session: ${rootKey}`);
    const folderName =
      folderUri.path.split('/').filter(Boolean).pop() ||
      folderUri.fsPath.split(/[\/\\]/).filter(Boolean).pop() ||
      'workspace';
    await gateway.sendRequest('sessions.create', {
      key: rootKey,
      label: folderName
    });
  }

  // Register in sessionToFolder map
  sessionToFolder.set(rootKey, folderUri);

  // Bootstrap state if not present
  let state = getSessionState(ctx, folderUri);
  if (!state) {
    state = { rootKey, chatKeys: [], activeKey: rootKey };
    saveSessionState(ctx, folderUri, state);
  } else {
    // Ensure rootKey is up-to-date (in case hash algorithm changed)
    state.rootKey = rootKey;
    if (!state.chatKeys.includes(state.activeKey) && state.activeKey !== rootKey) {
      state.activeKey = rootKey;
    }
    saveSessionState(ctx, folderUri, state);
  }

  return rootKey;
}

// ──────────────────────────────────────────────
// T4: New chat flow
// ──────────────────────────────────────────────

/**
 * Create a new child chat session under the folder root.
 * Returns the child session key.
 */
export async function newChat(
  gateway: GatewayConnection,
  ctx: vscode.ExtensionContext,
  folderUri: vscode.Uri
): Promise<string> {
  const logger = Logger.getInstance();

  // Get or init state
  let state = getSessionState(ctx, folderUri);
  if (!state) {
    const rootKey = await ensureFolderSession(gateway, ctx, folderUri);
    state = { rootKey, chatKeys: [], activeKey: rootKey };
  }

  // Create child session
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const childRes = await gateway.sendRequest('sessions.create', {
    parentSessionKey: state.rootKey,
    label: `Chat ${timestamp}`
  });

  // Response shape: { ok, key, sessionId, entry }
  const childKey: string = childRes?.key;
  if (!childKey) {
    throw new Error('Failed to create chat session: no key in response body');
  }

  // Update state
  state.chatKeys.push(childKey);
  state.activeKey = childKey;
  saveSessionState(ctx, folderUri, state);

  // Register in sessionToFolder
  sessionToFolder.set(childKey, folderUri);

  logger.info(`Created new chat: ${childKey} under ${state.rootKey}`);
  return childKey;
}

// ──────────────────────────────────────────────
// T5: Stale key recovery
// ──────────────────────────────────────────────

/**
 * Validate all owned sessions for a folder. Run on every reconnect.
 * - If root is gone, clear state and re-create
 * - Prune dead chat keys
 * - Fix activeKey if missing from chatKeys
 */
export async function validateOwnedSessions(
  gateway: GatewayConnection,
  ctx: vscode.ExtensionContext,
  folderUri: vscode.Uri
): Promise<void> {
  const logger = Logger.getInstance();
  const rootKey = folderRootKey(folderUri);
  const state = getSessionState(ctx, folderUri);

  if (!state) return;

  // Fetch all sessions in one request instead of N+1 individual describes
  let liveKeys: Set<string>;
  try {
    const res = await gateway.sendRequest('sessions.list', {});
    const sessions: SessionEntry[] = res?.sessions ?? [];
    liveKeys = new Set(sessions.map((s: SessionEntry) => s.key));
  } catch {
    // Can't validate without a list — skip pruning this cycle
    logger.warn('validateOwnedSessions: sessions.list failed, skipping validation');
    return;
  }

  if (!liveKeys.has(rootKey)) {
    logger.warn(`Root session ${rootKey} gone, recreating`);
    clearSessionState(ctx, folderUri);
    sessionToFolder.delete(rootKey);
    for (const ck of state.chatKeys) { sessionToFolder.delete(ck); }
    await ensureFolderSession(gateway, ctx, folderUri);
    return;
  }

  // Prune dead chat keys using the already-fetched live set
  const validChats: string[] = [];
  for (const ck of state.chatKeys) {
    if (liveKeys.has(ck)) {
      validChats.push(ck);
      sessionToFolder.set(ck, folderUri);
    } else {
      sessionToFolder.delete(ck);
      logger.debug(`Pruned dead chat key: ${ck}`);
    }
  }

  if (!validChats.includes(state.activeKey) && state.activeKey !== rootKey) {
    state.activeKey = validChats.length > 0 ? validChats[validChats.length - 1] : rootKey;
    logger.info(`Active key was stale, switched to: ${state.activeKey}`);
  }

  state.chatKeys = validChats;
  saveSessionState(ctx, folderUri, state);
}

// ──────────────────────────────────────────────
// T6: sessions.changed subagent auto-discovery
// ──────────────────────────────────────────────

const SESSION_CHANGE_HANDLER_KEY = 'openclaw.sessionChangeHandlerRegistered';

/**
 * Register a handler for sessions.changed events.
 * Builds sessionToFolder map at startup, then keeps it updated.
 * Registers a disposable on ctx.subscriptions so it cleans up on deactivation.
 *
 * Prerequisite: Group 3 must issue sessions.subscribe (no args) on every
 * connect/reconnect. Without it, sessions.changed never fires.
 */
export function registerSessionChangeHandler(
  gateway: GatewayConnection,
  ctx: vscode.ExtensionContext
): void {
  // Guard via workspaceState so deactivation + reactivation re-registers correctly
  if (ctx.workspaceState.get<boolean>(SESSION_CHANGE_HANDLER_KEY)) return;
  ctx.workspaceState.update(SESSION_CHANGE_HANDLER_KEY, true);
  ctx.subscriptions.push({ dispose: () => ctx.workspaceState.update(SESSION_CHANGE_HANDLER_KEY, undefined) });

  const logger = Logger.getInstance();

  // Build initial sessionToFolder map from all stored workspace folders
  if (vscode.workspace.workspaceFolders) {
    for (const wf of vscode.workspace.workspaceFolders) {
      const state = getSessionState(ctx, wf.uri);
      if (state) {
        sessionToFolder.set(state.rootKey, wf.uri);
        for (const ck of state.chatKeys) {
          sessionToFolder.set(ck, wf.uri);
        }
      }
    }
  }

  gateway.on('sessions.changed', async (payload: any) => {
    // Key field is `sessionKey` (NOT `key`). No `change` field — use `reason`.
    const changedKey: string = payload?.sessionKey;
    if (!changedKey) return;

    const reason: string = payload?.reason || '';
    const phase: string = payload?.phase || '';

    // Handle deletion / cleanup
    if (reason === 'delete' || reason === 'cleanup') {
      sessionToFolder.delete(changedKey);
      logger.debug(`Session ${changedKey} removed (${reason})`);

      // Also prune from stored state
      const folder = findFolderForKey(changedKey, ctx);
      if (folder) {
        const state = getSessionState(ctx, folder);
        if (state) {
          state.chatKeys = state.chatKeys.filter(ck => ck !== changedKey);
          if (state.activeKey === changedKey) {
            state.activeKey =
              state.chatKeys.length > 0
                ? state.chatKeys[state.chatKeys.length - 1]
                : state.rootKey;
          }
          saveSessionState(ctx, folder, state);
        }
      }
      return;
    }

    // Auto-discover: if parentSessionKey/spawnedBy is owned, register child
    const parentKey: string =
      payload?.parentSessionKey || payload?.spawnedBy || '';
    if (parentKey && sessionToFolder.has(parentKey)) {
      const folder = sessionToFolder.get(parentKey)!;
      sessionToFolder.set(changedKey, folder);

      // Add to chatKeys if not already tracked
      const state = getSessionState(ctx, folder);
      if (state && !state.chatKeys.includes(changedKey)) {
        state.chatKeys.push(changedKey);
        saveSessionState(ctx, folder, state);
      }

      logger.info(
        `Auto-discovered child session ${changedKey} under ${parentKey} (${reason || phase})`
      );
      return;
    }

    logger.debug(
      `sessions.changed: ${changedKey} reason=${reason} phase=${phase} (not owned, ignored)`
    );
  });
}

// ──────────────────────────────────────────────
// T6 helper: find which folder a key belongs to
// ──────────────────────────────────────────────

function findFolderForKey(
  key: string,
  ctx: vscode.ExtensionContext
): vscode.Uri | undefined {
  // Check sessionToFolder map first
  const fromMap = sessionToFolder.get(key);
  if (fromMap) return fromMap;

  // Fallback: scan stored state across all workspace folders
  if (!vscode.workspace.workspaceFolders) return undefined;

  for (const wf of vscode.workspace.workspaceFolders) {
    const state = getSessionState(ctx, wf.uri);
    if (
      state &&
      (state.rootKey === key || state.chatKeys.includes(key))
    ) {
      return wf.uri;
    }
  }

  return undefined;
}

// ──────────────────────────────────────────────
// T7: sessions.list — get owned sessions only
// ──────────────────────────────────────────────

/**
 * Fetch all sessions via sessions.list and filter to owned keys.
 * Do NOT call on connect — only when rendering the session tree.
 */
export async function getOwnedSessions(
  gateway: GatewayConnection
): Promise<SessionEntry[]> {
  const ownedKeys = new Set(sessionToFolder.keys());
  if (ownedKeys.size === 0) return [];

  const res = await gateway.sendRequest('sessions.list', {});
  if (!res || !res.sessions) return [];

  return res.sessions.filter((s: SessionEntry) => ownedKeys.has(s.key));
}

// ──────────────────────────────────────────────
// T8: Per-key message subscription
// ──────────────────────────────────────────────

/**
 * Subscribe to message events for a specific session.
 * Param is `key`, NOT `sessionKey`.
 *
 * If Group 3's global subscribe is active, this is redundant.
 * Only use for targeted subscription.
 */
export async function subscribeMessages(
  gateway: GatewayConnection,
  key: string
): Promise<void> {
  await gateway.sendRequest('sessions.messages.subscribe', { key });
}

// ──────────────────────────────────────────────
// T9: sessions.resolve
// ──────────────────────────────────────────────

/**
 * Resolve a session by label or agentId.
 * Returns the matching SessionEntry, or null if not found.
 */
export async function resolveSession(
  gateway: GatewayConnection,
  params: { label?: string; agentId?: string }
): Promise<SessionEntry | null> {
  const res = await gateway.sendRequest('sessions.resolve', params);
  return res?.session ?? null;
}

// ──────────────────────────────────────────────
// T10: sessions.delete / sessions.reset
// ──────────────────────────────────────────────

/**
 * Delete a session. Requires operator.admin scope.
 * Checks connection.authScopes first; surfaces a clear error if missing.
 */
export async function deleteSession(
  gateway: GatewayConnection,
  key: string
): Promise<void> {
  if (!gateway.authScopes.includes('operator.admin')) {
    throw new Error(
      'Cannot delete session: missing operator.admin scope. ' +
        'Check your gateway auth configuration.'
    );
  }
  await gateway.sendRequest('sessions.delete', { key });
  sessionToFolder.delete(key);
}

/**
 * Reset a session. Requires operator.admin scope.
 * Checks connection.authScopes first; surfaces a clear error if missing.
 */
export async function resetSession(
  gateway: GatewayConnection,
  key: string
): Promise<void> {
  if (!gateway.authScopes.includes('operator.admin')) {
    throw new Error(
      'Cannot reset session: missing operator.admin scope. ' +
        'Check your gateway auth configuration.'
    );
  }
  await gateway.sendRequest('sessions.reset', { key });
}

// ──────────────────────────────────────────────
// T11: chat.history limitation — documented below
// ──────────────────────────────────────────────

/**
 * NOTE (T11): chat.history { sessionKey, limit } may not return entries for
 * agent-initiated runs. The agent event stream (`event` type === 'agent') is
 * the primary transcript source. When chat.history returns an incomplete or
 * empty result, consumers should fall back to replaying buffered agent events.
 */
