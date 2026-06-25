import * as vscode from 'vscode';
import { Logger } from './logger';
import { GatewayConnection } from '../gateway/connection';

/**
 * MessageProcessor handles filtering and processing of incoming messages
 * from the Gateway to ensure proper display and response handling
 */
export class MessageProcessor {
    private static instance: MessageProcessor;
    private logger: Logger;
    
    private constructor() {
        this.logger = Logger.getInstance();
    }

    public static getInstance(): MessageProcessor {
        if (!MessageProcessor.instance) {
            MessageProcessor.instance = new MessageProcessor();
        }
        return MessageProcessor.instance;
    }

    /**
     * TASK 0-14: Register all gateway event handlers.
     * Call once after GatewayConnection is created, before connecting.
     * Wires sessions.subscribe on reconnect, tool routing, approvals, etc.
     */
    public registerEventHandlers(connection: GatewayConnection): void {
        // ── TASK 0: sessions.subscribe on every reconnect ──
        // Without this, sessions.changed, session.tool, and session.operation
        // are SILENTLY DROPPED by the gateway.
        connection.on('reconnected', async () => {
            try {
                await connection.sendRequest('sessions.subscribe', {});
                this.logger.info('Subscribed to session events (sessions.subscribe)');
            } catch (error) {
                this.logger.error('Failed sessions.subscribe on reconnect', error);
            }
        });

        // ── TASK 4: sessions.changed ──
        // Field is `sessionKey` NOT `key`. Field is `reason` NOT `change`.
        connection.on('sessions.changed', (payload: any) => {
            this.logger.info('Session changed', {
                sessionKey: payload.sessionKey,
                reason: payload.reason,
                phase: payload.phase,
                status: payload.status
            });
            // Emit as typed internal event for UI consumption
            connection.emit('processed_event', {
                type: 'session_changed',
                sessionKey: payload.sessionKey,
                reason: payload.reason,
                phase: payload.phase,
                status: payload.status,
                spawnedBy: payload.spawnedBy,
                parentSessionKey: payload.parentSessionKey,
                spawnDepth: payload.spawnDepth,
                subagentRole: payload.subagentRole,
                childSessions: payload.childSessions
            });
        });

        // ── TASK 5: session.tool ──
        // Route through same tool card logic as agent tool events.
        // session.tool comes via sessions.subscribe, NOT sessions.messages.subscribe.
        // It is a firehose MIRROR for every session on the gateway (exists so
        // operator UIs can attach to in-flight runs) — drop anything this
        // window doesn't watch before it reaches view logic.
        connection.on('session.tool', (payload: any) => {
            if (payload?.sessionKey && !connection.isWatchedSession(payload.sessionKey)) {
                return;
            }
            // Gateway nests tool data under payload.data
            const data = payload?.data ?? payload;
            const toolName = data.toolName || data.name;
            if (!toolName) return;
            this.logger.info('Session tool event', {
                phase: data.phase,
                toolCallId: data.toolCallId,
                toolName,
            });
            connection.emit('processed_event', {
                type: 'tool_event',
                runId: payload.runId || data.runId || 'session-tool',
                sessionKey: payload.sessionKey,
                seq: payload.seq || 0,
                phase: data.phase || 'start',
                toolCallId: data.toolCallId,
                toolName,
                args: data.args || {},
                result: data.result || '',
                isError: data.isError || false,
                timestamp: payload.ts || Date.now()
            });
        });

        // ── TASK 6: exec.approval.requested ──
        // Handled by ApprovalRelay (src/gateway/approvalRelay.ts), wired per-bridge
        // in OpenClawBridge so approvals surface through the shared inline UX
        // (with a native-modal fallback for unwatched sessions).

        // ── TASK 7: session.message ──
        // Same firehose-mirror rule as session.tool: watched sessions only.
        connection.on('session.message', (payload: any) => {
            if (payload?.sessionKey && !connection.isWatchedSession(payload.sessionKey)) {
                return;
            }
            this.logger.info('Session message', {
                sessionKey: payload.sessionKey,
                role: payload.role || payload.message?.role
            });
            connection.emit('processed_event', {
                type: 'session_message',
                sessionKey: payload.sessionKey,
                message: payload.message,
                role: payload.role || payload.message?.role
            });
        });

        // ── TASK 8: session.operation ──
        connection.on('session.operation', (payload: any) => {
            this.logger.info('Session operation', {
                sessionKey: payload.sessionKey,
                operation: payload.operation,
                phase: payload.phase
            });
            vscode.window.setStatusBarMessage(
                `OpenClaw: ${payload.operation || 'operation'} ${payload.phase || ''}`.trim(),
                3000
            );
        });

        // ── TASK 9: presence ──
        connection.on('presence', (payload: any) => {
            this.logger.info('Presence event', payload);
        });

        // ── TASK 10: talk.mode / talk.event ──
        connection.on('talk.mode', (payload: any) => {
            this.logger.info('Talk mode', payload);
        });
        connection.on('talk.event', (payload: any) => {
            this.logger.info('Talk event', payload);
        });

        // ── TASK 11: cron ──
        connection.on('cron', (payload: any) => {
            this.logger.info('Cron event', payload);
        });

        // ── TASK 12: heartbeat ──
        connection.on('heartbeat', (_payload: any) => {
            this.logger.debug('Heartbeat received');
        });

        // ── TASK 13: node.pair.requested ──
        connection.on('node.pair.requested', (payload: any) => {
            this.logger.info('Node pair requested', payload);
            if (!connection.authScopes?.includes('operator.pairing')) {
                this.logger.warn('node.pair.requested: missing operator.pairing scope');
                return;
            }
            vscode.window.showInformationMessage(
                `OpenClaw: Node pairing requested${payload.nodeName ? ` — ${payload.nodeName}` : ''}`
            );
        });

        // ── TASK 14: plugin.approval.requested ──
        // Also handled by ApprovalRelay (see TASK 6 note).

        this.logger.info('Event handlers registered');
    }

    /**
     * Process incoming message from Gateway
     * Filters out unnecessary content and ensures proper handling
     */
    public processIncomingMessage(message: any): any {
        try {
            // Skip processing for health and tick events
            if (message.type === 'event' && (message.event === 'health' || message.event === 'tick')) {
                return null; // Don't process these events further
            }
            
            // Handle chat messages
            if (message.type === 'event' && message.event === 'chat') {
                return this.processChatMessage(message);
            }
            
            // Handle agent events
            if (message.type === 'event' && message.event === 'agent') {
                return this.processAgentEvent(message);
            }
            
            // Handle responses
            if (message.type === 'res') {
                return this.processResponse(message);
            }
            
            return message; // Return original message if no special processing needed
        } catch (error) {
            this.logger.error('Error processing message', error);
            return message; // Return original message on error
        }
    }
    
    /**
     * Process chat messages
     */
    private processChatMessage(message: any): any {
        // Extract just the relevant content from chat messages
        if (message.payload && message.payload.message) {
            const content = message.payload.message.content;
            const text = this.extractMessageText(content);
            if (text) {
                return {
                    type: 'chat_message',
                    runId: message.payload.runId,
                    sessionKey: message.payload.sessionKey,
                    state: message.payload.state,
                    role: message.payload.message.role,
                    content: text,
                    messageId: message.payload.message?.messageId || message.payload.message?.id || message.payload.messageId,
                    nativeMessageId: message.payload.message?.nativeMessageId || message.payload.message?.messageId || message.payload.message?.id || message.payload.messageId,
                    channel: message.payload.channel,
                    to: message.payload.to,
                    accountId: message.payload.accountId,
                    reactionTarget: message.payload.reactionTarget || message.payload.message?.reactionTarget,
                    timestamp: message.payload.timestamp
                };
            }

            this.logger.warn('Dropped chat_message with unsupported content shape', {
                sessionKey: message.payload.sessionKey,
                role: message.payload.message.role,
                contentType: Array.isArray(content) ? 'array' : typeof content,
            });
            return null;
        }
        return message;
    }

    private extractMessageText(content: any): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (part && typeof part.text === 'string') return part.text;
                    if (part && typeof part.content === 'string') return part.content;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        if (content && typeof content === 'object') {
            if (typeof content.text === 'string') return content.text;
            if (typeof content.content === 'string') return content.content;
        }
        return '';
    }
    
    /**
     * Process agent events
     */
    private processAgentEvent(message: any): any {
        // Handle agent events - extract the most relevant information
        if (message.payload && message.payload.data) {
            const stream = message.payload.stream;
            const data = message.payload.data;
            
            // TASK 1: Thinking stream — currently dropped entirely; add the case
            if (stream === 'thinking' && data.text) {
                return {
                    type: 'thinking_chunk',
                    text: data.text,
                    runId: message.payload.runId,
                    sessionKey: message.payload.sessionKey
                };
            }

            // TASK 3: Item stream events
            if (stream === 'item' && data) {
                return {
                    type: 'item_event',
                    item: data,
                    runId: message.payload.runId,
                    sessionKey: message.payload.sessionKey
                };
            }

            // For lifecycle events
            if (stream === 'lifecycle') {
                return {
                    type: 'agent_lifecycle',
                    phase: data.phase,
                    runId: message.payload.runId,
                    sessionKey: message.payload.sessionKey,
                    timestamp: message.payload.ts
                };
            }
            
            // For assistant stream, extract the text
            if (stream === 'assistant' && data.text) {
                return {
                    type: 'agent_message',
                    runId: message.payload.runId,
                    seq: message.payload.seq,
                    text: data.text,
                    delta: data.delta || '',
                    sessionKey: message.payload.sessionKey,
                    messageId: data.messageId || data.id || message.payload.messageId,
                    nativeMessageId: data.nativeMessageId || data.messageId || data.id || message.payload.messageId,
                    channel: data.channel || message.payload.channel,
                    to: data.to || data.target || message.payload.to,
                    accountId: data.accountId || message.payload.accountId,
                    reactionTarget: data.reactionTarget || message.payload.reactionTarget,
                    timestamp: message.payload.ts
                };
            }
            
            // NEW: Handle tool stream events
            if (stream === 'tool') {
                // Tool events can have different phases: start, update, result
                const toolCallId = data.toolCallId;
                const toolName = data.toolName || data.name;
                const args = data.args || {}; // Only available in 'start' phase
                const result = data.result || ''; // Only available in 'result' phase
                const isError = data.isError || false; // Only in 'result' phase
                
                return {
                    type: 'tool_event',
                    runId: message.payload.runId,
                    seq: message.payload.seq,
                    phase: data.phase || 'unknown',
                    toolCallId: toolCallId,
                    toolName: toolName,
                    args: args,
                    result: result,
                    isError: isError,
                    sessionKey: message.payload.sessionKey,
                    timestamp: message.payload.ts
                };
            }
        }
        return message;
    }
    
    /**
     * Process response messages
     */
    private processResponse(message: any): any {
        // Ensure responses are properly tracked and handled
        if (message.hasError) {
            this.logger.warn(`Error in response for request ${message.id}`, message);
        }
        return message;
    }
    
}
