/**
 * GatewayCapabilities — capability detection from the `hello-ok` handshake.
 *
 * The gateway's connect/hello-ok response advertises everything we need to
 * tailor the UI to the connected server (boutique workspace-aware build vs.
 * stock vanilla openclaw):
 *
 *   - protocol            (integer)
 *   - server.version      (string)
 *   - features.methods[]  (every supported RPC method name)
 *   - features.events[]   (every supported event name)
 *   - auth.scopes[]        (granted operator scopes)
 *
 * Schema lives in openclaw's packages/gateway-protocol/src/schema/frames.ts
 * (HelloOkSchema) and is present in BOTH the boutique and vanilla builds, so
 * the same detection works everywhere.
 *
 * Design principle: correctness comes from per-method gating (`hasMethod`),
 * never from `isBoutique`. `isBoutique` only decides whether to surface the
 * richer enhancement bundle. Vanilla is the guaranteed baseline; boutique is
 * progressive enhancement. The UI renders from the capability set, so an
 * unknown/older gateway yields a smaller-but-functional surface, not errors.
 */

/** Shape of the relevant slice of a hello-ok / connect response. */
export interface HelloOkLike {
    protocol?: number;
    server?: { version?: string; connId?: string };
    features?: { methods?: string[]; events?: string[] };
    auth?: { scopes?: string[] };
    pluginSurfaceUrls?: Record<string, string>;
}

/**
 * Method names that only the boutique workspace-aware build is expected to
 * expose. Used solely to flag the enhancement bundle — refine after diffing
 * the live `features.methods` of both gateways (logged at connect via
 * {@link GatewayCapabilities.describe}). Add markers here as they're confirmed.
 */
const BOUTIQUE_MARKER_METHODS: readonly string[] = [
    'matrix.verify.bootstrap',
    'matrix.verify.recoveryKey',
    'matrix.verify.status',
];

export class GatewayCapabilities {
    readonly protocol: number;
    readonly version: string;
    readonly methods: ReadonlySet<string>;
    readonly events: ReadonlySet<string>;
    readonly scopes: ReadonlySet<string>;
    /** True only when `features.methods` was advertised (protocol ≥ 4). */
    readonly methodsKnown: boolean;
    /** True when `features.events` was advertised. */
    readonly eventsKnown: boolean;
    /** Enhancement-bundle flag — see BOUTIQUE_MARKER_METHODS. Not for correctness. */
    readonly isBoutique: boolean;

    constructor(hello?: HelloOkLike) {
        this.protocol = hello?.protocol ?? 0;
        this.version = hello?.server?.version ?? 'unknown';

        const methods = hello?.features?.methods;
        const events = hello?.features?.events;
        this.methodsKnown = Array.isArray(methods);
        this.eventsKnown = Array.isArray(events);
        this.methods = new Set(methods ?? []);
        this.events = new Set(events ?? []);
        this.scopes = new Set(hello?.auth?.scopes ?? []);

        this.isBoutique = BOUTIQUE_MARKER_METHODS.some((m) => this.methods.has(m));
    }

    /**
     * Whether an RPC method is available. When the gateway did not advertise a
     * method list (older protocol), this returns `true` optimistically — the
     * caller should rely on runtime error handling as a fallback.
     */
    hasMethod(name: string): boolean {
        if (!this.methodsKnown) return true;
        return this.methods.has(name);
    }

    hasEvent(name: string): boolean {
        if (!this.eventsKnown) return true;
        return this.events.has(name);
    }

    hasScope(name: string): boolean {
        return this.scopes.has(name);
    }

    // ── Derived feature flags (consumed by the UI) ───────────────────────────

    /** Mid-run "steer" dispatch: inject a message into a running session. */
    canSteer(): boolean {
        if (!this.hasScope('operator.write') && !this.hasScope('operator.admin')) return false;
        if (this.hasMethod('sessions.steer') || this.hasMethod('chat.inject')) return true;

        // Current OpenClaw hides sessions.steer/chat.inject from advertised
        // feature lists even though modern gateways implement them. Let the
        // bridge try the call and fall back to queue on runtime failure.
        return this.protocol >= 4 && this.hasMethod('sessions.send');
    }

    /** Session-level model override (vs. per-request agent({provider,model})). */
    canSetSessionModel(): boolean {
        return this.hasMethod('sessions.patch') && this.hasScope('operator.admin');
    }

    canListAgents(): boolean {
        return this.hasMethod('agents.list');
    }

    canListSessions(): boolean {
        return this.hasMethod('sessions.list');
    }

    canListCommands(): boolean {
        return this.hasMethod('commands.list');
    }

    canListModels(): boolean {
        return this.hasMethod('models.list');
    }

    canAbort(): boolean {
        return this.hasMethod('chat.abort') || this.hasMethod('sessions.abort');
    }

    /** One-line summary for connect-time logging. */
    describe(): string {
        const methodCount = this.methodsKnown ? this.methods.size : -1;
        return [
            `version=${this.version}`,
            `protocol=${this.protocol}`,
            `boutique=${this.isBoutique}`,
            `methods=${methodCount >= 0 ? methodCount : 'unknown'}`,
            `scopes=${this.scopes.size}`,
        ].join(' ');
    }
}
