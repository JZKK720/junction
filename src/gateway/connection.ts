import * as vscode from 'vscode';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec as nodeExec } from 'child_process';
import { Logger } from '../utils/logger';
import { MessageProcessor } from '../utils/messageProcessor';
import { GatewayCapabilities } from './capabilities';
import { getOpenClawConfigPath, getOpenClawGatewayUrl } from '../config/agentBridgeConfig';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  method: string;
  params: any;
  timestamp: number;
  timeoutHandle?: NodeJS.Timeout;
  idleCheckHandle?: NodeJS.Timeout;
}

export class GatewayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private get GATEWAY_URL(): string {
    return getOpenClawGatewayUrl();
  }
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectAttempts = 0;
  private logger: Logger;
  private lastError: Error | null = null;
  private lastActivity: number = Date.now();
  private pingInterval: NodeJS.Timeout | null = null;
  private isAuthenticated = false;
  private isPairingPending = false;
  private lastResolvedConfigPath: string | null = null;
  private messageProcessor: MessageProcessor;
  private secrets: vscode.SecretStorage | null = null;
  private instanceId: string = crypto.randomUUID();

  // Extracted from hello-ok; groups 2/4/6 check these for scope gating
  public authScopes: string[] = [];

  // Detected gateway capabilities (methods/events/version) from hello-ok.
  // Drives dual-build UX gating — boutique vs. vanilla. See capabilities.ts.
  public capabilities: GatewayCapabilities = new GatewayCapabilities();

  // Plugin HTTP surface URLs from hello-ok (keyed by plugin id)
  public pluginSurfaceUrls: Record<string, string> = {};

  // Accumulated file-path context (fed by sendFilePath.ts, consumed by sessionManager)
  private pendingFileContext: string | null = null;

  // WebSocket readyState constants
  private readonly WS_OPEN = 1;

  constructor(secrets?: vscode.SecretStorage, instanceId?: string) {
    super();
    this.logger = Logger.getInstance();
    this.messageProcessor = MessageProcessor.getInstance();
    this.secrets = secrets ?? null;
    if (instanceId) this.instanceId = instanceId;
  }

  /**
   * Transport-level session scoping. The gateway's global `sessions.subscribe`
   * firehose mirrors `session.message` / `session.tool` for EVERY session (it
   * exists so operator UIs can attach to in-flight runs). This window only
   * cares about the sessions its views actually display — events for
   * unwatched sessions are dropped in the message processor before any view
   * logic runs, so cross-window bleed is impossible by construction.
   * (`sessions.changed` list updates always pass; run-scoped events for runs
   * this connection started are delivered directly by the gateway anyway.)
   */
  private readonly watchedSessions = new Set<string>();

  public watchSession(key: string): void {
    const k = String(key ?? '').trim();
    if (k) this.watchedSessions.add(k);
  }

  public unwatchSession(key: string): void {
    this.watchedSessions.delete(String(key ?? '').trim());
  }

  public isWatchedSession(key: unknown): boolean {
    const k = String(key ?? '').trim();
    return !!k && this.watchedSessions.has(k);
  }

  /**
   * Generate a unique request ID
   */
  private generateId(): string {
    return `vscode-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * Connect to the Gateway
   */
  public async connect(): Promise<boolean> {
    if (this.ws && this.ws.readyState === this.WS_OPEN) {
      this.logger.debug('Already connected to Gateway');
      return true;
    }

    if (this.isConnecting) {
      this.logger.debug('Connection to Gateway already in progress');
      return false;
    }

    this.isConnecting = true;
    
    try {
      // Get auth config before attempting connection
      const authConfig = await this.getAuthConfig();
      const hasAnyAuth = Object.values(authConfig).some(v => typeof v === 'string' && v.length > 0);

      if (!hasAnyAuth) {
        this.logger.error('No auth token found. Use the OpenClaw sidebar to select a gateway.');
        this.isConnecting = false;
        return false;
      }

      this.logger.info(`Connecting to ${this.GATEWAY_URL} with auth keys: ${Object.keys(authConfig).join(', ')}`);

      return new Promise<boolean>((resolve, reject) => {
        this.ws = new WebSocket(this.GATEWAY_URL);

        // Set up challenge listener BEFORE any events can fire so we never miss it.
        // The gateway sends connect.challenge immediately after the socket opens.
        const challengePromise = new Promise<string | null>((resolveChallenge) => {
          const timeout = setTimeout(() => {
            this.logger.warn('connect.challenge not received within 5s — proceeding without device auth');
            resolveChallenge(null);
          }, 5000);

          const onChallenge = (data: WebSocket.Data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'event' && msg.event === 'connect.challenge' && msg.payload?.nonce) {
                clearTimeout(timeout);
                this.ws?.off('message', onChallenge);
                resolveChallenge(String(msg.payload.nonce));
              }
            } catch {}
          };
          this.ws!.on('message', onChallenge);
        });

        this.ws.on('open', () => {
          this.logger.info('WebSocket open — waiting for connect.challenge');
          this.reconnectAttempts = 0;
          this.lastActivity = Date.now();
          this.startPingInterval();

          this.sendConnectRequest(authConfig, challengePromise)
            .then(() => {
              this.isConnecting = false;
              this.isAuthenticated = true;
              this.emit('connected');
              resolve(true);
            })
            .catch((error) => {
              this.logger.error('Failed to authenticate with Gateway', error);
              this.isConnecting = false;
              this.disconnect();
              reject(error);
            });
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.lastActivity = Date.now();
          this.handleMessage(data);
        });
        
        this.ws.on('error', (error) => {
          this.logger.error('WebSocket error', error);
          this.lastError = error;
          this.isConnecting = false;
          resolve(false);
        });
        
        this.ws.on('close', (code: number, reason: Buffer) => {
          const reasonStr = reason?.toString() ?? '';
          this.logger.info(`Disconnected from Gateway (code=${code}${reasonStr ? ', reason=' + reasonStr : ''})`);
          this.isAuthenticated = false;
          this.isConnecting = false;
          this.clearPingInterval();

          // 1008 = policy violation; gateway uses it for pairing-required rejections
          if (code === 1008 || reasonStr.toLowerCase().includes('pairing required')) {
            const requestId = reasonStr.match(/\(requestId:\s*([^\s)]+)\)/i)?.[1];
            this.showPairingNotification(requestId);
            resolve(false);
            return;
          }

          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.attemptReconnect();
          } else {
            this.emit('disconnected');
          }

          resolve(false);
        });
      });
    } catch (error) {
      this.logger.error('Failed to connect to Gateway', error);
      this.isConnecting = false;
      return false;
    }
  }

  /**
   * Send the initial connect request as required by the Gateway protocol
   */
  private async sendConnectRequest(
    authConfig: Record<string, string>,
    challengePromise: Promise<string | null>,
  ): Promise<void> {
    const hasAnyAuth = Object.values(authConfig).some(v => typeof v === 'string' && v.length > 0);
    if (!hasAnyAuth) {
      throw new Error('No auth token found. Select a gateway via the OpenClaw sidebar to load credentials.');
    }

    try {
      // Wait for the challenge nonce the gateway sends right after socket open
      const nonce = await challengePromise;

      // Build device auth payload if we got a nonce
      let devicePayload: object | undefined;
      if (nonce) {
        devicePayload = await this.buildDeviceAuth(nonce, authConfig);
      }

      const requestedScopes = [
        'operator.read',
        'operator.write',
        'operator.admin',
        'operator.approvals',
        'operator.pairing',
        'operator.talk.secrets',
      ];

      const response = await this.sendRequest('connect', {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: 'cli',
          version: vscode.version || '1.0.0',
          platform: os.platform(),
          mode: 'cli',
          displayName: 'VS Code OpenClaw',
          deviceFamily: 'vscode',
          instanceId: this.instanceId,
        },
        caps: ['tool-events'],
        role: 'operator',
        scopes: requestedScopes,
        auth: authConfig,
        ...(devicePayload ? { device: devicePayload } : {}),
      });

      this.isPairingPending = false;

      if (response && response.auth) {
        this.authScopes = response.auth.scopes ?? [];
        this.logger.info('Auth scopes granted: ' + (this.authScopes.length > 0 ? this.authScopes.join(', ') : '(none)'));

        if (response.auth.deviceToken) {
          await this.saveAuthToken('deviceToken', response.auth.deviceToken);
        }
      }

      // Detect gateway capabilities from the hello-ok payload (dual-build UX).
      this.capabilities = new GatewayCapabilities(response);
      this.logger.info('Gateway capabilities: ' + this.capabilities.describe());

      if (response && response.pluginSurfaceUrls) {
        this.pluginSurfaceUrls = response.pluginSurfaceUrls;
        this.logger.info('Plugin surface URLs: ' + Object.keys(this.pluginSurfaceUrls).join(', '));
      }

      this.emit('reconnected');
      return;
    } catch (error: any) {
      const msg = String(error?.message ?? error ?? '');
      const isPairing =
        error?.code === 'PAIRING_REQUIRED' ||
        error?.code === 'DEVICE_NOT_PAIRED' ||
        msg.toLowerCase().includes('pairing required');

      if (isPairing) {
        const requestId: string | undefined =
          (typeof error?.requestId === 'string' && error.requestId) ||
          msg.match(/\(requestId:\s*([^\s)]+)\)/i)?.[1] ||
          undefined;
        this.showPairingNotification(requestId);
      } else {
        this.logger.error('Failed to authenticate with Gateway', error);
      }
      throw error;
    }
  }

  /**
   * Handle all incoming messages from the Gateway
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const rawMessage = data.toString();
      const message = JSON.parse(rawMessage);
      
      // // Special debug for agent events (where tool calls live)
      // if (message.type === 'event' && message.event === 'agent') {
      //   const payload = message.payload;
      //   const stream = payload?.stream;
        
      //   // Extra debug for tool events
      //   if (stream === 'tool') {
      //     const data = payload?.data || {};
      //     this.logger.info('TOOL EVENT RECEIVED!', {
      //       stream: stream,
      //       phase: data.phase,
      //       toolName: data.toolName || data.name || 'unknown',
      //       toolCallId: data.toolCallId || data.id || 'unknown',
      //       data_keys: Object.keys(data)
      //     });
          
      //     // Log tool content for debugging
      //     if (data.content && data.content.length < 500) {
      //       this.logger.debug('Tool content:', data.content);
      //     }
      //   }
        
      //   this.logger.debug('AGENT EVENT DETAILS:', {
      //     stream: stream,
      //     seq: payload?.seq,
      //     runId: payload?.runId,
      //     data_keys: payload?.data ? Object.keys(payload.data) : 'no data',
      //     data_type: typeof payload?.data,
      //     data_string: JSON.stringify(payload?.data).substring(0, 200)
      //   });
      // }

      // Process the message using MessageProcessor
      const processedMessage = this.messageProcessor.processIncomingMessage(message);
      
      // Skip further processing if the message processor returns null
      if (processedMessage === null) {
        return;
      }
      
      // Handle different message types
      if (message.type === 'res') {
        this.handleResponse(message);
      } else if (message.type === 'event') {
        this.handleEvent(message, processedMessage);
      } else {
        this.logger.debug('Received unknown message type', message);
      }
    } catch (error) {
      this.logger.error('Failed to parse message from Gateway', error);
    }
  }

  /**
   * Handle response messages (replies to our requests)
   */
  private handleResponse(message: any): void {
    const requestId = message.id;
    const pendingRequest = this.pendingRequests.get(requestId);
    
    if (pendingRequest) {
      this.pendingRequests.delete(requestId);
      if (pendingRequest.timeoutHandle) {
        clearTimeout(pendingRequest.timeoutHandle);
      }
      if (pendingRequest.idleCheckHandle) {
        clearInterval(pendingRequest.idleCheckHandle);
      }
      
      if (message.ok === false) {
        this.logger.warn(`Request ${requestId} (${pendingRequest.method}) failed`, message.error);
        pendingRequest.reject(message.error || new Error('Unknown error'));
      } else {
        pendingRequest.resolve(message.payload);
      }
    } else {
      this.logger.warn(`Response for unknown request: ${requestId}`);
    }
  }

  /**
   * Handle event messages (unsolicited messages from the Gateway)
   */
  private handleEvent(message: any, processedMessage: any): void {
    const eventType = message.event;
    
    // Ignore connect.challenge when using token auth
    if (eventType === 'connect.challenge') {
      this.logger.debug('Ignoring connect.challenge event');
      return;
    }
    
    // Handle graceful shutdown event (T4)
    if (eventType === 'shutdown') {
      this.handleShutdown(message.payload);
      return;
    }
    
    // Log the event type for debugging
    this.logger.debug(`Received event`, { event: eventType, hasPayload: !!message.payload });

    // Emit the event for subscribers
    this.emit(eventType, message.payload);
    this.emit('event', { type: eventType, payload: message.payload });
    this.emit('message', message);
    if (this.isGatedUnwatchedStream(processedMessage)) return;
    this.emit('processed_event', processedMessage);
  }

  /** Conversation-stream event types that must never cross session scope. */
  private static readonly SESSION_GATED_TYPES = new Set([
    'chat_message', 'agent_message', 'thinking_chunk',
    'tool_event', 'item_event', 'session_message',
  ]);

  /**
   * Transport choke point for the cross-window bleed: conversation-stream
   * events for sessions this window doesn't watch are dropped here, before
   * any view logic. Lifecycle/list events (`session_changed` etc.) always
   * pass — they feed the chats list, not transcripts. Sessions are watched
   * at send/adopt time, so a window's own runs always stream.
   */
  private isGatedUnwatchedStream(processedMessage: any): boolean {
    if (!processedMessage || typeof processedMessage !== 'object') return false;
    if (!GatewayConnection.SESSION_GATED_TYPES.has(processedMessage.type)) return false;
    const key = String(processedMessage.sessionKey ?? '').trim();
    if (!key) return false; // run-scoped events without a key are already targeted
    return !this.isWatchedSession(key);
  }


  /**
   * Send a raw message over the WebSocket
   */
  private sendRawMessage(message: any): void {
    if (!this.ws || this.ws.readyState !== this.WS_OPEN) {
      throw new Error('Not connected to Gateway');
    }
    
    const messageStr = JSON.stringify(message);
    this.logger.debug(`Sending: ${messageStr.substring(0, 100)}...`);
    this.ws.send(messageStr);
    this.lastActivity = Date.now();
  }

  /**
   * Keep the connection alive with regular pings
   */
  private startPingInterval(): void {
    this.clearPingInterval();
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.WS_OPEN) {
        // Send a ping if no activity for more than 30 seconds
        const inactivityTime = Date.now() - this.lastActivity;
        if (inactivityTime > 30000) {
          try {
            this.sendRequest('ping', {}).catch(err => {
              this.logger.warn('Ping failed', err);
            });
          } catch (error) {
            this.logger.warn('Failed to send ping', error);
          }
        }
      }
    }, 30000);
  }

  /**
   * Clear the ping interval
   */
  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Get the authentication config.
   * Rotated tokens (deviceToken) are read from SecretStorage when available.
   * Initial bootstrap tokens fall back to ~/.openclaw/openclaw.json.
   */

  // ── Device identity helpers ──────────────────────────────────────────────

  private static readonly ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  private static readonly ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

  private static base64UrlEncode(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private static pemEncode(label: 'PUBLIC KEY' | 'PRIVATE KEY', der: Buffer): string {
    const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
  }

  private static deriveRawPublicKey(publicKeyPem: string): Buffer {
    const key = crypto.createPublicKey(publicKeyPem);
    const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
    const prefix = GatewayConnection.ED25519_SPKI_PREFIX;
    if (spki.length === prefix.length + 32 && spki.subarray(0, prefix.length).equals(prefix)) {
      return spki.subarray(prefix.length);
    }
    return spki;
  }

  private static deviceIdFromPublicKey(publicKeyPem: string): string {
    const raw = GatewayConnection.deriveRawPublicKey(publicKeyPem);
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Derive the device identity path from the resolved gateway config directory.
   * When the config lives at ~/.ling/openclaw.json, the identity lands at
   * ~/.ling/identity/device.json. Falls back to ~/.openclaw/identity/device.json
   * when no config path has been resolved yet.
   */
  private defaultIdentityPath(): string {
    const base = this.lastResolvedConfigPath
      ? path.dirname(this.lastResolvedConfigPath)
      : path.join(os.homedir(), '.openclaw');
    return path.join(base, 'identity', 'device.json');
  }

  private async loadOrCreateDeviceIdentity(): Promise<{
    deviceId: string; publicKeyPem: string; privateKeyPem: string;
  }> {
    const filePath = this.defaultIdentityPath();
    const dir = path.dirname(filePath);

    // Try to load existing identity
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const stored = JSON.parse(raw);
      if (stored.version === 1 && stored.publicKeyPem && stored.privateKeyPem) {
        const deviceId = GatewayConnection.deviceIdFromPublicKey(stored.publicKeyPem);
        this.logger.info(`Loaded device identity: ${deviceId.slice(0, 16)}…`);
        return { deviceId, publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };
      }
    } catch {
      // Not found or malformed — create new
    }

    // Generate new ed25519 identity
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const deviceId = GatewayConnection.deviceIdFromPublicKey(publicKeyPem);

    const stored = { version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    this.logger.info(`Created new device identity: ${deviceId.slice(0, 16)}…`);

    return { deviceId, publicKeyPem, privateKeyPem };
  }

  private async buildDeviceAuth(
    nonce: string,
    authConfig: Record<string, string>,
  ): Promise<object> {
    const identity = await this.loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();

    // Resolve which auth token to include in the signed payload.
    // Must match gateway's resolveSignatureToken: token > deviceToken > bootstrapToken.
    const tokenForSig = authConfig.token ?? authConfig.deviceToken ?? authConfig.bootstrapToken ?? '';

    const scopes = [
      'operator.read', 'operator.write', 'operator.admin',
      'operator.approvals', 'operator.pairing', 'operator.talk.secrets',
    ].join(',');

    // v3 payload format (matches buildDeviceAuthPayloadV3 in gateway source)
    const payload = [
      'v3',
      identity.deviceId,
      'cli',         // clientId
      'cli',         // clientMode
      'operator',    // role
      scopes,
      String(signedAtMs),
      tokenForSig,
      nonce,
      os.platform(),       // platform
      'vscode',             // deviceFamily (matches client.deviceFamily in connect frame)
    ].join('|');

    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);

    return {
      id: identity.deviceId,
      publicKey: GatewayConnection.base64UrlEncode(GatewayConnection.deriveRawPublicKey(identity.publicKeyPem)),
      signature: GatewayConnection.base64UrlEncode(sig),
      signedAt: signedAtMs,
      nonce,
    };
  }

  private async getAuthConfig(): Promise<Record<string, string>> {
    const auth: Record<string, string> = {};

    // 1. Include a previously-rotated deviceToken from SecretStorage if present.
    //    NOTE: do NOT return early here. The gateway's connect-auth logic tries
    //    device auth first, but falls through to token/password auth when the
    //    device is unpaired/stale AND a shared secret is also supplied. If we send
    //    only the deviceToken, an unpaired device hard-rejects with "pairing
    //    required" even though a valid token sits in the config. So we merge both.
    if (this.secrets) {
      const storedDevice = await Promise.resolve(
        this.secrets.get('junction.openclaw.deviceToken')
          .then(v => v || this.secrets!.get('openclaw.deviceToken'))
      ).catch(() => undefined);
      if (storedDevice) {
        auth.deviceToken = storedDevice;
      }
    }

    // 2. Resolve the config file path, trying three sources in order:
    //    a. openclaw.configPath setting (set explicitly by user / discovery)
    //    b. Lock-file lookup: match current gateway port against running instances
    //    c. Fallback: ~/.openclaw/openclaw.json
    const configPath = await this.resolveConfigPath();
    if (!configPath) {
      if (Object.keys(auth).length > 0) {
        // Have a deviceToken but no config — still worth attempting the connect.
        return auth;
      }
      this.logger.error('Could not find an openclaw.json for the current gateway URL. Use the OpenClaw sidebar to select a gateway.');
      return auth;
    }
    this.lastResolvedConfigPath = configPath;

    try {
      const configContent = await fs.promises.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      const src = config.gateway?.auth ?? config.gateway ?? {};

      for (const key of ['token', 'bootstrapToken', 'deviceToken', 'password', 'approvalRuntimeToken']) {
        // Don't let a stale on-disk deviceToken clobber the freshly-rotated one
        // already loaded from SecretStorage.
        if (key === 'deviceToken' && auth.deviceToken) continue;
        if (typeof src[key] === 'string' && src[key]) {
          auth[key] = src[key];
        }
      }
      this.logger.info(`Loaded auth from ${configPath} (keys: ${Object.keys(auth).join(', ')})`);
    } catch (error) {
      this.logger.error(`Failed to read auth from ${configPath}`, error);
    }

    return auth;
  }

  private async resolveConfigPath(): Promise<string | null> {
    // a. Explicit setting
    const explicit = getOpenClawConfigPath();
    if (explicit) {
      try { await fs.promises.access(explicit); this.logger.info(`Using explicit configPath: ${explicit}`); return explicit; } catch {}
    }

    // b. Derive from gateway URL port via lock files
    const gatewayUrl = getOpenClawGatewayUrl();
    this.logger.info(`Resolving config for gatewayUrl: ${gatewayUrl}`);
    const portMatch = gatewayUrl.match(/:(\d+)$/);
    if (portMatch) {
      const targetPort = parseInt(portMatch[1], 10);
      this.logger.info(`Scanning lock files for port ${targetPort}`);
      const configPath = await this.findConfigPathByPort(targetPort);
      if (configPath) { this.logger.info(`Found config via lock file: ${configPath}`); return configPath; }
      this.logger.warn(`No lock file found for port ${targetPort}`);
    }

    // c. Legacy default location
    const defaultPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    try { await fs.promises.access(defaultPath); this.logger.info(`Using default config: ${defaultPath}`); return defaultPath; } catch {}

    return null;
  }

  private async findConfigPathByPort(targetPort: number): Promise<string | null> {
    try {
      const uid = process.getuid ? process.getuid() : 1000;
      const lockDir = path.join(os.tmpdir(), `openclaw-${uid}`);
      const entries = await fs.promises.readdir(lockDir);
      const lockFiles = entries.filter(e => e.startsWith('gateway.') && e.endsWith('.lock'));

      for (const lockFile of lockFiles) {
        try {
          const raw = await fs.promises.readFile(path.join(lockDir, lockFile), 'utf-8');
          const lock: { pid: number; configPath: string } = JSON.parse(raw);
          if (!lock.configPath) continue;

          const configRaw = await fs.promises.readFile(lock.configPath, 'utf-8');
          const config = JSON.parse(configRaw);
          if (config?.gateway?.port === targetPort) {
            return lock.configPath;
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  private showPairingNotification(requestId: string | undefined): void {
    if (this.isPairingPending) return;

    this.isPairingPending = true;
    this.emit('pairingRequired');

    this.logger.warn('━━━ Device pairing required ━━━');
    this.logger.warn('Approve command: ' + this.buildApproveCommand(requestId));

    vscode.window.showInformationMessage(
      'OpenClaw: this device needs to be approved before it can connect.',
      'Approve Pairing',
      'Cancel',
    ).then(action => {
      if (action === 'Approve Pairing') {
        this.runApprove(requestId);
      }
      // Cancel: leave isPairingPending=true, do nothing
    });
  }

  private async runApprove(requestId: string | undefined): Promise<void> {
    let rid = requestId;

    // If we don't have the requestId yet, trigger a fresh connect attempt so the
    // gateway creates a new pending request, then immediately list it.
    if (!rid) {
      this.logger.info('Triggering fresh connect to create pending request...');
      await this.connect(); // will get 1008 again; showPairingNotification guards against re-showing
      await new Promise(r => setTimeout(r, 300)); // let gateway register the request

      const listCmd = this.buildApproveCommand(undefined) + ' --latest --json';
      this.logger.info('Fetching pending requestId: ' + listCmd);
      const out = await this.execCapture(listCmd);
      this.logger.info('list output: ' + out.slice(0, 800));
      for (const line of out.split('\n')) {
        try {
          const data = JSON.parse(line.trim());
          if (data?.selected?.requestId) { rid = data.selected.requestId; break; }
        } catch {}
      }
    }

    if (!rid) {
      this.logger.warn('Could not find a pending requestId in CLI output');
      vscode.window.showErrorMessage('OpenClaw: no pending pairing request found — check the OpenClaw output log.');
      return;
    }

    const approveCmd = this.buildApproveCommand(rid);
    this.logger.info('Approving: ' + approveCmd);

    try {
      const out = await this.execSilent(approveCmd);
      this.logger.info('approve output: ' + out.slice(0, 400));
      vscode.window.showInformationMessage('OpenClaw: device approved — connecting...');
      this.isPairingPending = false;
      this.reconnectAttempts = 0;
      this.connect().catch(err => this.logger.error('Connect after approval failed', err));
    } catch (err: any) {
      this.logger.warn('Approval command failed: ' + String(err?.message ?? err));
      vscode.window.showErrorMessage('OpenClaw: approval failed — check the OpenClaw output log.');
    }
  }

  /** Run cmd through the user's login shell so PATH is fully resolved. */
  private loginShell(cmd: string): { shell: string; args: string[] } {
    const shell = process.env.SHELL || '/bin/bash';
    return { shell, args: ['-lc', cmd] };
  }

  /** Resolves with stdout+stderr only on exit code 0, rejects otherwise. */
  private execSilent(cmd: string): Promise<string> {
    const { shell, args } = this.loginShell(cmd);
    return new Promise((resolve, reject) => {
      const child = require('child_process').spawn(shell, args, { env: process.env });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', (code: number) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out.slice(-300)}`)));
    });
  }

  /** Always resolves with all output regardless of exit code. */
  private execCapture(cmd: string): Promise<string> {
    const { shell, args } = this.loginShell(cmd);
    return new Promise((resolve) => {
      const child = require('child_process').spawn(shell, args, { env: process.env });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', () => resolve(out));
    });
  }

  private buildApproveCommand(requestId: string | undefined): string {
    const parts: string[] = [];
    const profile = this.resolveProfileFromConfigPath(this.lastResolvedConfigPath);

    if (profile === null && this.lastResolvedConfigPath) {
      // Non-standard state dir (e.g. ~/.jiminy) — set it directly so CLI reads the right config+URL
      const stateDir = path.dirname(this.lastResolvedConfigPath);
      parts.push(`OPENCLAW_STATE_DIR='${stateDir}'`);
    }

    parts.push('openclaw');
    if (profile) {
      parts.push('--profile', profile);
    }
    parts.push('devices', 'approve');
    if (requestId) {
      parts.push(requestId);
    }
    return parts.join(' ');
  }

  private resolveProfileFromConfigPath(configPath: string | null): string | undefined | null {
    if (!configPath) return undefined;

    // Resolve symlinks first (e.g. ~/.ling → ~/.openclaw-ling)
    let resolved = configPath;
    try { resolved = fs.realpathSync(configPath); } catch { /* keep original */ }

    const home = os.homedir();
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Default profile: ~/.openclaw/openclaw.json
    if (resolved === path.join(home, '.openclaw', 'openclaw.json')) return undefined;

    // Named profile: ~/.openclaw-<name>/openclaw.json
    const namedMatch = resolved.match(
      new RegExp(`^${escapedHome}[\\/]\\.openclaw-([^\\/]+)[\\/]openclaw\\.json$`)
    );
    if (namedMatch) return namedMatch[1];

    // Non-standard path — caller will use OPENCLAW_STATE_DIR
    return null;
  }

  /**
   * Attempt to reconnect after a connection failure
   */
  private attemptReconnect(): void {
    if (this.isPairingPending) {
      this.logger.info('Skipping reconnect — waiting for user to approve device pairing');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    this.logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(error => {
        this.logger.error('Reconnection attempt failed', error);
      });
    }, delay);
  }

  /**
   * Send a request to the Gateway and await response
   */
  public async sendRequest(
    method: string,
    params: any,
    options?: { timeoutMs?: number; idleTimeoutMs?: number }
  ): Promise<any> {
    if (!this.ws || this.ws.readyState !== this.WS_OPEN) {
      await this.connect();
      
      if (!this.ws || this.ws.readyState !== this.WS_OPEN) {
        throw new Error('Failed to connect to Gateway');
      }
    }
    
    const id = this.generateId();
    const request = {
      type: 'req',
      id,
      method,
      params
    };
    
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        method,
        params,
        timestamp: Date.now()
      };

      this.pendingRequests.set(id, pending);
      
      try {
        this.sendRawMessage(request);
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
      
      // Set a timeout for the request.
      // NOTE: When idleTimeoutMs is set, the request is aborted if no gateway
      // activity is seen for that duration — even if the agent is still working.
      // sessionManager.ts passes idleTimeoutMs: 15000 which may be too low for
      // long agent runs (the gateway's agent.wait default is 30s). Without an
      // idleTimeoutMs override, the fallback is timeoutMs (default 30000) which
      // is a sensible 30s total timeout.
      if (options?.idleTimeoutMs) {
        const idleTimeoutMs = options.idleTimeoutMs;
        pending.idleCheckHandle = setInterval(() => {
          if (!this.pendingRequests.has(id)) {
            return;
          }
          const idleFor = Date.now() - this.lastActivity;
          if (idleFor > idleTimeoutMs) {
            this.pendingRequests.delete(id);
            clearInterval(pending.idleCheckHandle!);
            reject(new Error(`Request ${method} idle timed out after ${idleTimeoutMs} ms`));
          }
        }, 1000);
      } else {
        const timeoutMs = options?.timeoutMs ?? 30000;
        pending.timeoutHandle = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`Request ${method} timed out after ${timeoutMs} ms`));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * Send a message via chat.send
   */
  public async sendMessage(method: string, params: any): Promise<any> {
    this.logger.info(`Sending ${method} message`, { messageLength: JSON.stringify(params).length });
    
    try {
      // Add idempotency key to prevent duplicate messages
      if (params && !params.idempotencyKey) {
        params.idempotencyKey = this.generateId();
      }
      
      return await this.sendRequest(method, params);
    } catch (error) {
      this.logger.error(`Failed to send ${method} message`, error);
      throw error;
    }
  }

  /**
   * Get the current connection status
   */
  public isConnected(): boolean {
    return !!this.ws && this.ws.readyState === this.WS_OPEN && this.isAuthenticated;
  }

  /**
   * Handle graceful gateway shutdown event (T4)
   */
  private handleShutdown(payload: any): void {
    const { reason, restartExpectedMs } = payload || {};
    this.logger.info(`Gateway shutting down: ${reason}`, { restartExpectedMs });
    
    vscode.window.showWarningMessage(
      `OpenClaw gateway shutting down: ${reason || 'unknown reason'}`
    );
    
    // If gateway will restart, wait before reconnecting; otherwise wait for WS close
    if (typeof restartExpectedMs === 'number' && restartExpectedMs > 0) {
      this.clearPingInterval();
      // Add 2s buffer beyond the announced restart time
      setTimeout(() => {
        if (!this.isConnected()) {
          this.isConnecting = false;
          this.connect().catch(err =>
            this.logger.error('Post-shutdown reconnect failed', err)
          );
        }
      }, restartExpectedMs + 2000);
    }
    // Otherwise let the normal close→reconnect path handle it
  }
  
  /**
   * Stage file context for the next agent message (fed by sendFilePath.ts, T3)
   */
  public setPendingFileContext(context: string): void {
    this.pendingFileContext = context;
  }
  
  /**
   * Retrieve and clear staged file context (consumed by sessionManager)
   */
  public getPendingFileContext(): string | null {
    const ctx = this.pendingFileContext;
    this.pendingFileContext = null;
    return ctx;
  }
  
  /**
   * Save a rotated auth token. Stores in SecretStorage (OS keychain) when
   * available; falls back to updating the on-disk config.
   */
  private async saveAuthToken(key: string, value: string): Promise<void> {
    if (this.secrets) {
      try {
        await this.secrets.store(`junction.openclaw.${key}`, value);
        this.logger.info(`Saved rotated ${key} to SecretStorage`);
        return;
      } catch (err) {
        this.logger.warn(`SecretStorage.store failed for ${key}, falling back to disk`, err);
      }
    }

    try {
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      try { await fs.promises.access(configPath); } catch { return; }

      const configContent = await fs.promises.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);

      if (!config.gateway) config.gateway = {};
      if (!config.gateway.auth) config.gateway.auth = {};
      config.gateway.auth[key] = value;

      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
      this.logger.info(`Saved rotated ${key} to disk config`);
    } catch (error) {
      this.logger.error(`Failed to save ${key} to config`, error);
    }
  }

  /**
   * Clean disconnect from Gateway
   */
  public disconnect(): void {
    this.clearPingInterval();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      try {
        if (this.ws.readyState === this.WS_OPEN) {
          this.ws.close();
        }
      } catch (error) {
        this.logger.warn('Error while disconnecting from Gateway', error);
      } finally {
        this.ws = null;
        this.isAuthenticated = false;
      }
    }
    
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
      }
      if (pending.idleCheckHandle) {
        clearInterval(pending.idleCheckHandle);
      }
      pending.reject(new Error('Connection lost'));
    }
    this.pendingRequests.clear();
  }
}
