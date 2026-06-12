import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';
import {
  VSCODE_WORKSPACE_CONTEXT_PREFIX,
} from '../bridges/types';
import {
  folderRootKey,
  ensureFolderSession,
  newChat,
  validateOwnedSessions,
  registerSessionChangeHandler,
  getSessionState,
  saveSessionState,
  isOwned,
  sessionToFolder,
  resolveSession,
  deleteSession,
  resetSession,
  subscribeMessages,
  getOwnedSessions,
  FolderSessionState
} from './folderSessions';

export class SessionManager extends EventEmitter {
  private gateway: GatewayConnection;
  private logger: Logger;
  private ctx: vscode.ExtensionContext;

  /** Active session key per folder (folderUri.toString() → sessionKey) */
  private activeSessions: Map<string, string> = new Map();

  get context(): vscode.ExtensionContext { return this.ctx; }

  constructor(gateway: GatewayConnection, ctx: vscode.ExtensionContext) {
    super();
    this.gateway = gateway;
    this.ctx = ctx;
    this.logger = Logger.getInstance();

    // ── T3 + T5: Wire reconnection hooks ──
    this.gateway.on('reconnected', () => {
      this.onReconnected();
    });

    // ── T6: Register sessions.changed handler ──
    registerSessionChangeHandler(gateway, ctx);

    // Track current session from agent/chat events
    this.gateway.on('event', (event) => {
      if (
        (event.type === 'agent' || event.type === 'chat') &&
        event.payload?.sessionKey
      ) {
        const key = event.payload.sessionKey;
        if (sessionToFolder.has(key)) {
          const folderUri = sessionToFolder.get(key)!;
          this.activeSessions.set(folderUri.toString(), key);
        }
        this.logger.debug(`Event session key: ${key}`);
      }
    });

    this.gateway.on('processed_event', (event) => {
      this.emit('stream', event);
    });
  }

  // ── T3 + T5: Re-establish sessions on every reconnect ──
  private async onReconnected(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    for (const wf of folders) {
      try {
        if (getSessionState(this.ctx, wf.uri)) {
          await validateOwnedSessions(this.gateway, this.ctx, wf.uri);
        }
      } catch (err) {
        this.logger.error(
          `Failed to re-establish session for ${wf.uri.fsPath}`,
          err
        );
      }
    }
  }

  /**
   * Initialize sessions for all workspace folders.
   * Call once during extension activate.
   */
  async initializeFolderSessions(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.logger.warn('No workspace folders open');
      return;
    }

    for (const wf of folders) {
      try {
        if (getSessionState(this.ctx, wf.uri)) {
          await validateOwnedSessions(this.gateway, this.ctx, wf.uri);
        }
      } catch (err) {
        this.logger.error(
          `Failed to initialize sessions for ${wf.uri.fsPath}`,
          err
        );
      }
    }
  }

  // ── Session key resolution ──

  /**
   * Get or determine the active session key for a folder.
   * Prefers cached active key → stored activeKey → root session.
   */
  async ensureSession(folderUri?: vscode.Uri): Promise<string> {
    if (!folderUri) {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        throw new Error('No workspace folder open');
      }
      folderUri = folders[0].uri;
    }

    // 1. Cached active key
    const cached = this.activeSessions.get(folderUri.toString());
    if (cached && isOwned(cached)) {
      return cached;
    }

    // 2. Stored state activeKey
    const state = getSessionState(this.ctx, folderUri);
    if (state && state.activeKey && isOwned(state.activeKey)) {
      this.activeSessions.set(folderUri.toString(), state.activeKey);
      return state.activeKey;
    }

    // 3. Ensure root exists, use as default
    const rootKey = await ensureFolderSession(
      this.gateway,
      this.ctx,
      folderUri
    );
    this.activeSessions.set(folderUri.toString(), rootKey);
    return rootKey;
  }

  /**
   * Create a new chat session under the folder root. (T4)
   */
  async createNewChat(folderUri?: vscode.Uri): Promise<string> {
    if (!folderUri) {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        throw new Error('No workspace folder open');
      }
      folderUri = folders[0].uri;
    }

    const key = await newChat(this.gateway, this.ctx, folderUri);
    this.activeSessions.set(folderUri.toString(), key);
    return key;
  }

  /**
   * Switch the active session for a folder.
   */
  setActiveSession(folderUri: vscode.Uri, key: string): void {
    if (!isOwned(key)) {
      this.logger.warn(`Attempted to activate unowned session: ${key}`);
      return;
    }
    this.activeSessions.set(folderUri.toString(), key);

    const state = getSessionState(this.ctx, folderUri);
    if (state) {
      state.activeKey = key;
      saveSessionState(this.ctx, folderUri, state);
    }
  }

  // ── Messaging ──

  /**
   * Send a chat message on the active session.
   */
  /** Keys that have already had workspace context injected this session. */
  private injectedSessions = new Set<string>();

  /** Turn counters per session — workspace context is re-injected every N turns. */
  private turnCounters = new Map<string, number>();
  private static readonly CONTEXT_INJECT_INTERVAL = 5;

  /** Agent overrides set from the webview menus. */
  private agentOverrides: { agentId?: string; provider?: string; model?: string; thinking?: string } = {};

  setAgentOverrides(o: { agentId?: string; provider?: string; model?: string; thinking?: string }): void {
    this.agentOverrides = { ...this.agentOverrides, ...o };
  }

  async sendChatMessage(message: string, context?: any): Promise<any> {
    const folderUri = context?.workspaceFolder
      ? vscode.Uri.file(context.workspaceFolder)
      : undefined;
    const sessionKey = await this.ensureSession(folderUri);
    // Watch before the agent request fires: the transport gate drops
    // conversation-stream events for unwatched sessions.
    this.gateway.watchSession(sessionKey);

    try {
      this.logger.info('Sending chat message', { sessionKey, messageLength: message.length });

      // Set verboseLevel so tool events are visible
      const bindDir = context?.workspaceFolder ?? context?.workspace;
      const supportsWorkspaceSessions = !!bindDir && this.gateway.capabilities.supportsWorkspaceSessions();
      try {
        await this.gateway.sendRequest('sessions.patch', {
          key: sessionKey,
          verboseLevel: 'on',
          // Fork gateway resolves active workspace from spawnedCwd; explicit CLI workspace bind still wins.
          ...(supportsWorkspaceSessions ? { spawnedCwd: bindDir } : {}),
        });
      } catch (patchError) {
        this.logger.warn('Failed to set verboseLevel, tool events may not be visible', patchError);
      }

      // Workspace context is already bound via sessions.patch(spawnedCwd) for
      // workspace-aware sessions. For non-workspace sessions, inject once
      // at session start — NOT per message. The gateway treats chat.inject
      // messages as visible turns, so we avoid re-injecting.
      // (The VSCODE_WORKSPACE_CONTEXT_PREFIX is informational; the agent
      // already gets workspace from the session binding.)

      const result = await this.gateway.sendRequest(
        'agent',
        {
          sessionKey,
          message,
          idempotencyKey: this.generateId(),
          ...(this.agentOverrides.agentId ? { agentId: this.agentOverrides.agentId } : {}),
          ...(this.agentOverrides.provider ? { provider: this.agentOverrides.provider } : {}),
          ...(this.agentOverrides.model ? { model: this.agentOverrides.model } : {}),
          ...(this.agentOverrides.thinking ? { thinking: this.agentOverrides.thinking } : {}),
        },
        { idleTimeoutMs: 15000 }
      );

      return result;
    } catch (error) {
      this.logger.error('Failed to send chat message', error);
      throw error;
    }
  }

  /**
   * Get chat history. (T11)
   *
   * NOTE: `chat.history { sessionKey, limit }` may not return entries for
   * agent-initiated runs. The agent event stream is the primary transcript
   * source. When this returns incomplete data, fall back to replaying
   * buffered agent events.
   */
  async getSessionHistory(
    limit: number = 50,
    folderUri?: vscode.Uri
  ): Promise<any> {
    const sessionKey = await this.ensureSession(folderUri);

    try {
      this.logger.info('Fetching chat history', { sessionKey, limit });

      const result = await this.gateway.sendRequest('chat.history', {
        sessionKey,
        limit
      });

      return result;
    } catch (error) {
      this.logger.warn(
        'chat.history may not work for agent-initiated sessions. ' +
          'The agent event stream is the primary transcript source.',
        error
      );
      throw error;
    }
  }

  // ── Utilities ──

  /**
   * Read session JSONL file directly for infinite scroll.
   * Returns messages from the tail of the file, skipping non-message lines.
   * @param sessionKey The session key to look up via sessions.list
   * @param offset Byte offset from end of file to start reading (0 = most recent)
   * @param maxBytes Maximum bytes to read
   */
  async getSessionHistoryFromJsonl(
    sessionKey: string,
    offset: number = 0,
    maxBytes: number = 256 * 1024
  ): Promise<{ messages: any[]; hasMore: boolean; nextOffset: number }> {
    try {
      // Resolve sessionKey → sessionId + agentId via sessions.list
      const configPath = this.getConfigPath();
      if (!configPath) {
        return { messages: [], hasMore: false, nextOffset: 0 };
      }

      // Look up the session to get sessionId and agentId
      let sessionId: string | undefined;
      let agentId: string | undefined;
      try {
        const listResult = await this.gateway.sendRequest('sessions.list', {});
        const sessions = Array.isArray(listResult?.sessions) ? listResult.sessions : [];
        const match = sessions.find((s: any) => s.key === sessionKey);
        if (match) {
          sessionId = match.sessionId;
          agentId = match.agentId;
        }
      } catch {
        // sessions.list unavailable — fall through to unavailable
      }

      if (!sessionId) {
        return { messages: [], hasMore: false, nextOffset: 0 };
      }

      // Derive profile directory from config path
      const profileDir = path.dirname(path.resolve(configPath));
      const resolvedAgentId = agentId || 'main';
      const sessionsDir = path.join(profileDir, 'agents', resolvedAgentId, 'sessions');
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

      // Check if file exists
      try {
        await fs.promises.access(sessionFile);
      } catch {
        return { messages: [], hasMore: false, nextOffset: 0 };
      }

      // Read from end of file
      const stat = await fs.promises.stat(sessionFile);
      const fileSize = stat.size;

      if (fileSize === 0) {
        return { messages: [], hasMore: false, nextOffset: 0 };
      }

      // Calculate read window — window ends at (fileSize - offset), not at fileSize
      const readEnd = Math.max(0, fileSize - offset);
      const readStart = Math.max(0, readEnd - maxBytes);
      let bytesRead = readEnd - readStart;

      if (bytesRead <= 0) {
        return { messages: [], hasMore: false, nextOffset: offset };
      }

      // Read the chunk
      const buffer = Buffer.alloc(bytesRead);
      const fd = await fs.promises.open(sessionFile, 'r');
      try {
        await fd.read(buffer, 0, bytesRead, readStart);
      } finally {
        await fd.close();
      }

      let text = buffer.toString('utf-8');

      // When reading from a mid-file offset, skip the truncated first line
      // (it was fully captured by the previous page read).
      let nextOffset = offset + bytesRead;
      if (readStart > 0) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline >= 0) {
          text = text.slice(firstNewline + 1);
        } else {
          // No newline found — entire chunk is one partial line; skip it
          return { messages: [], hasMore: readStart > 0, nextOffset };
        }
      }

      const lines = text.split('\n').filter(line => line.trim());

      // Parse messages (only type: "message" entries) — already chronological
      const messages: any[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'message' && entry.message) {
            messages.push(entry.message);
          }
        } catch {
          // Skip malformed lines
        }
      }

      const hasMore = readStart > 0;

      // Non-progress guard: if nextOffset hasn't advanced, signal done
      if (nextOffset <= offset && hasMore) {
        return { messages, hasMore: false, nextOffset };
      }

      return { messages, hasMore, nextOffset };
    } catch (error) {
      this.logger.warn('Failed to read session JSONL', error);
      return { messages: [], hasMore: false, nextOffset: 0 };
    }
  }

  private getConfigPath(): string | null {
    // Get config path from VS Code settings
    const config = vscode.workspace.getConfiguration('junction.openclaw');
    return config.get<string>('configPath', '') || null;
  }

  private generateId(): string {
    return `vscode-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  getCurrentSessionKey(folderUri?: vscode.Uri): string | null {
    if (folderUri) {
      return this.activeSessions.get(folderUri.toString()) ?? null;
    }
    const first = this.activeSessions.values().next();
    return first.done ? null : first.value;
  }

  clearSession(folderUri?: vscode.Uri): void {
    if (folderUri) {
      this.activeSessions.delete(folderUri.toString());
    } else {
      this.activeSessions.clear();
    }
    this.logger.info('Session(s) cleared');
  }

  // ── Delegates to folderSessions ──

  isOwned = isOwned;

  resolveSession(params: { label?: string; agentId?: string }) {
    return resolveSession(this.gateway, params);
  }

  deleteSession(key: string) {
    return deleteSession(this.gateway, key);
  }

  resetSession(key: string) {
    return resetSession(this.gateway, key);
  }

  subscribeMessages(key: string) {
    return subscribeMessages(this.gateway, key);
  }

  getOwnedSessions() {
    return getOwnedSessions(this.gateway);
  }

  getFolderState(folderUri: vscode.Uri): FolderSessionState | undefined {
    return getSessionState(this.ctx, folderUri);
  }

  /** Expose sessionToFolder for read access */
  getSessionToFolder(): ReadonlyMap<string, vscode.Uri> {
    return sessionToFolder;
  }
}
