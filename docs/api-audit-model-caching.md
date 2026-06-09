# OpenClaw Model Catalog Caching — Architecture Audit

> **Date:** 2026-05-31  
> **Scope:** ~/sauce/openclaw-src  
> **Purpose:** Document caching patterns to replicate in the VSCode extension.

---

## 1. Gateway Model Catalog Cache (`server-model-catalog.ts`)

### Structure

The gateway maintains a **dual-cache** at module scope — *two* `GatewayModelCatalogCache` instances, one for read-only (`models.list` with `view=default`) and one for full catalog loads (`view=all`).

```typescript
type GatewayModelCatalogCache = {
  lastSuccessfulCatalog: GatewayModelChoice[] | null;  // cached result
  inFlightRefresh: Promise<GatewayModelChoice[]> | null; // dedup in-flight
  staleGeneration: number;       // incremented to mark stale
  appliedGeneration: number;     // set when a fresh result is applied
};
```

### Caching Strategy

**Stale-while-revalidate with in-flight dedup:**

1. **Cache hit (not stale):** Return `lastSuccessfulCatalog` immediately.
2. **Cache hit (stale):** Return stale data immediately, fire `startGatewayModelCatalogRefresh()` in the background (fire-and-forget via `void`).
3. **Cache miss + in-flight:** Await the existing `inFlightRefresh` promise — deduplicates concurrent requests.
4. **Cache miss + no in-flight:** Start a new refresh and await it.

```typescript
export async function loadGatewayModelCatalog(params?) {
  const cache = resolveGatewayModelCatalogCache(params);
  const isStale = isGatewayModelCatalogStale(cache);
  
  if (!isStale && cache.lastSuccessfulCatalog !== null) {
    return cache.lastSuccessfulCatalog;                // Fresh hit
  }
  if (isStale && cache.lastSuccessfulCatalog !== null) {
    if (!cache.inFlightRefresh) {
      void startGatewayModelCatalogRefresh(params);    // Stale → bg refresh
    }
    return cache.lastSuccessfulCatalog;                // Return stale
  }
  if (cache.inFlightRefresh) {
    return await cache.inFlightRefresh;                // Dedup in-flight
  }
  return await startGatewayModelCatalogRefresh(params); // Cold start
}
```

**Key design decisions:**
- No TTL — cache lives for the process lifetime (gateway daemon).
- Invalidated **only on config reload** (see §4).
- Fallback on load failure: the last successful catalog is preserved.
- Empty catalog result (0 models) → cache is cleared (`modelCatalogPromise = null` in `model-catalog.ts`) so it can retry next time.
- Dynamic import errors are NOT cached — the `modelCatalogPromise` is cleared on failure so future calls retry rather than replaying a rejected promise.

### Populating the Model Catalog (`model-catalog.ts`)

The actual catalog is built in `loadModelCatalog()` by:
1. Reading `models.json` via the PI SDK (`pi-model-discovery-runtime.ts`)
2. Adding manifest plugin model declarations
3. Adding provider-plugin runtime augmentations (read-only mode skips this)
4. Adding user-configured model rows from `config.models.providers`

The result is cached in a module-scoped `modelCatalogPromise` (valid only for `readOnly=false` loads).

---

## 2. Matrix Bridge / Auto-Reply Model Resolution

### How Models Are Resolved Per Message

The auto-reply pipeline (`get-reply.ts` → `model-selection.ts`) resolves models with a **conditional lazy-load** approach:

#### `createModelSelectionState()` in `reply/model-selection.ts`

```typescript
const needsModelCatalog =
  params.hasModelDirective ||           // User typed "/model ..."
  Boolean(hasAllowlist &&               // Agent has models.defaults allowlist
    visibility.providerWildcards.size > 0 && 
    !defaultProviderVisibleByWildcard);

if (needsModelCatalog) {
  modelCatalog = await loadModelCatalog({ config: cfg });  // Full load
  // Build visibility policy from full catalog
  visibilityPolicy = createModelVisibilityPolicy({ cfg, catalog: modelCatalog, ... });
} else if (hasAllowlist) {
  // Use configured models only — no catalog fetch needed
  visibilityPolicy = createModelVisibilityPolicy({ cfg, catalog: configuredModelCatalog, ... });
}
```

**Three paths:**
1. **No directive, no allowlist:** Skip entirely — use default provider/model from config. Zero catalog load.
2. **Allowlist only, no wildcards:** Use `buildConfiguredModelCatalog()` from config — no external PI SDK load.
3. **Model directive OR wildcard allowlist:** Full `loadModelCatalog()` with PI SDK discovery (reads `models.json` + provider auth).

**Lazy thinking/reasoning default resolution:** `resolveDefaultThinkingLevel()` lazily loads the full catalog **only** if the selected model's reasoning capability is unknown from the already-loaded catalog:

```typescript
const shouldHydrateRuntimeCatalog =
  !modelCatalog && (!selectedCatalogEntry || selectedCatalogEntry.reasoning === undefined);
if (shouldHydrateRuntimeCatalog) {
  modelCatalog = await loadModelCatalog({ config: cfg }); // Lazy full load
}
```

### Model Directive Flow

When a user types `/model anthropic/claude-sonnet`:
1. `extractModelDirective()` parses the `/model` out of the message body
2. `resolveModelSelectionFromDirective()` looks up the model in:
   - Configured model catalog (from `config.models.providers`)
   - The full model catalog (if loaded)
   - Falls back to configured defaults

### `resolveSelectedAndActiveModel()` (`auto-reply/model-runtime.ts`)

This resolves the final `{selected, active}` model pair:
- `selected` = what was configured/directive-specified
- `active` = what actually runs (may differ if session override exists)
- Returns `activeDiffers: boolean` for display purposes

---

## 3. Hello-OK Snapshot

### What It Contains

The hello-ok response is built in `message-handler.ts`:

```typescript
const helloOk = {
  type: "hello-ok",
  protocol: PROTOCOL_VERSION,
  server: { version, connId },
  features: { methods: gatewayMethods, events },
  snapshot,           // ← Snapshot struct
  auth: { role, scopes, deviceToken, ... },
  policy: { maxPayload, maxBufferedBytes, tickIntervalMs },
};
```

### Snapshot Schema (`gateway/protocol/schema/snapshot.ts`)

```typescript
const SnapshotSchema = Type.Object({
  presence: Type.Array(PresenceEntrySchema),
  health: HealthSnapshotSchema,         // async; filled in after connect
  stateVersion: StateVersionSchema,     // { presence, health }
  uptimeMs: Type.Integer(),
  sessionDefaults: SessionDefaultsSchema, // { defaultAgentId, mainKey, ... }
  authMode: optional,                   // only with ADMIN scope
  updateAvailable: optional,
});
```

### Does `models.list` Appear in the Snapshot?

**No.** The hello-ok snapshot does NOT include model catalog data. The `health` field contains system health metrics (CPU, memory, disk, provider auth status, model pricing health) but not the model list.

### Can We Avoid `models.list` by Reading hello-ok?

**Not directly.** The snapshot alone doesn't carry model data. However, the VSCode extension could pre-load the catalog in parallel with the connect handshake using a separate `models.list` RPC right after receiving hello-ok, rather than waiting for the user to open a model picker.

### Other Startup Methods Available in Snapshot

- `sessionDefaults` — the default agent ID, main session key, scope
- `presence` — connected clients (nodes, browsers, CLIs)
- `updateAvailable` — latest version info
- `auth.scopes` — tells the client what it's authorized to do
- `pluginSurfaceUrls` — HTTP URLs for plugin surfaces (separate from snapshot)
- `features.methods` and `features.events` — available RPC methods and event streams

---

## 4. Cache Invalidation

### Gateway Model Catalog Invalidation

**Trigger:** Config reload only.

In `server-reload-handlers.ts`:

```typescript
function resetPreparedModelRuntimeStateForHotReload(): void {
  resetModelCatalogCache();              // Clears model-catalog.ts promise
  clearCurrentProviderAuthState();       // Clears provider auth state
  markGatewayModelCatalogStaleForReload(); // Increments staleGeneration
}
```

`markGatewayModelCatalogStaleForReload()` increments `staleGeneration` on both caches. The next request gets stale data immediately while a background refresh starts.

### What `resetModelCatalogCache()` Does (`model-catalog.ts`)

```typescript
export function resetModelCatalogCache() {
  modelCatalogPromise = null;          // Reset the full catalog promise
  hasLoggedModelCatalogError = false;  // Allow re-logging errors
  hasLoggedReadOnlyStaticCatalogError = false;
}
```

### When Does Config Reload Happen?
- Config file write detected by file watcher
- Manual `config.reload` RPC (if enabled)
- SIGUSR1 restart (triggers full reset)

### No Reconnect-Based Invalidation

The gateway doesn't invalidate the model cache on client connect/disconnect. The cache is **process-lifetime**. Only config changes trigger invalidation.

---

## 5. Client-Side Caching Patterns

### Gateway Client (`gateway/client.ts`)

The `GatewayClient` class:
- Stores `helloOk` response in `this.helloOk` after connect
- Exposes `onHelloOk` callback for consumers
- **Does NOT** cache `models.list` responses — each request goes through the full RPC pipeline
- **Does NOT** invalidate anything on reconnect — the snapshot in `helloOk` is the source of truth

### VSCode Extension Current State (`modelManager.ts`)

```typescript
class ModelManager {
  private cache: ModelCache | null = null;  // Single in-memory cache
  
  async getModels(gateway: GatewayConnection): Promise<ProviderGroup[]> {
    if (this.cache) return this.cache.providers;          // Cache hit
    // ... fetch + cache
  }
  
  invalidate(): void {
    this.cache = null;  // Blows away entire cache
  }
}
```

**Problems:**
1. No in-flight dedup — concurrent calls to `getModels()` both fetch
2. No stale-while-revalidate — cache miss blocks the UI
3. Invalidation is all-or-nothing — no generation counter
4. No timeout — if fetch hangs, caller blocks forever
5. No error fallback — if fetch fails, no stale data fallback

---

## 6. Recommended Caching Strategy for VSCode Extension

### Core Pattern: Stale-While-Revalidate + In-Flight Dedup

Adopt the gateway's `GatewayModelCatalogCache` pattern exactly:

```typescript
interface ModelCacheEntry {
  providers: ProviderGroup[];
  flatModels: Map<string, ModelEntry>;
}

interface ModelCacheState {
  lastSuccessful: ModelCacheEntry | null;
  inFlightRefresh: Promise<ModelCacheEntry> | null;
  staleGeneration: number;
  appliedGeneration: number;
}
```

```typescript
class ModelManager {
  private cache: ModelCacheState = {
    lastSuccessful: null,
    inFlightRefresh: null,
    staleGeneration: 0,
    appliedGeneration: 0,
  };

  async getModels(gateway: GatewayConnection): Promise<ProviderGroup[]> {
    const isStale = this.cache.appliedGeneration < this.cache.staleGeneration;
    
    // 1. Fresh hit → return immediately
    if (!isStale && this.cache.lastSuccessful !== null) {
      return this.cache.lastSuccessful.providers;
    }
    
    // 2. Stale hit → return stale, fire background refresh
    if (isStale && this.cache.lastSuccessful !== null) {
      if (!this.cache.inFlightRefresh) {
        void this.startRefresh(gateway).catch(() => {});
      }
      return this.cache.lastSuccessful.providers;
    }
    
    // 3. In-flight dedup → await existing refresh
    if (this.cache.inFlightRefresh) {
      const entry = await this.cache.inFlightRefresh;
      return entry.providers;
    }
    
    // 4. Cold start → fetch and await
    return this.startRefresh(gateway).then(e => e.providers);
  }

  private async startRefresh(gateway: GatewayConnection): Promise<ModelCacheEntry> {
    const generation = this.cache.staleGeneration;
    const refresh = this.fetchModels(gateway).then(entry => {
      if (generation === this.cache.staleGeneration) {
        this.cache.lastSuccessful = entry;
        this.cache.appliedGeneration = this.cache.staleGeneration;
      }
      return entry;
    }).finally(() => {
      if (this.cache.inFlightRefresh === refresh) {
        this.cache.inFlightRefresh = null;
      }
    });
    this.cache.inFlightRefresh = refresh;
    return refresh;
  }

  /** Call on reconnect (and config change if detectable). */
  invalidate(): void {
    this.cache.staleGeneration += 1;
  }
}
```

### Specific Code Patterns to Adopt

1. **In-flight dedup** — use a Promise reference to deduplicate concurrent cache-miss calls.

2. **Generation counter (not boolean flag)** — `staleGeneration++` instead of `cache = null`. This means stale data is never thrown away, only superseded.

3. **Stale-while-revalidate** — return stale on staleness, fire background refresh. The VSCode model picker never blocks on a cold fetch.

4. **Call on reconnect** — in the `GatewayConnection.connected` handler (which fires after `helloOk`), call `modelManager.invalidate()` to mark the cache stale. The next `getModels()` call returns stale immediately while refreshing.

5. **Lazy load only when needed** — don't fetch the catalog at startup. The Matrix bridge uses a `needsModelCatalog` guard; adopt the same: only fetch when the user opens a model picker, sends a `/model` directive, or when allowlists require catalog resolution.

6. **Timeout with stale fallback** — if the gateway doesn't respond within 750ms (matching `DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS`), return stale data or an empty catalog.

7. **On-accepted pattern** — for the model picker UI, use the `onAccepted` callback from `GatewayClientRequestOptions` to show "Loading models..." immediately while the catalog is fetched in the background (matching how the gateway sends accepted responses before final results for long-running operations).

### Implementation Priority

| Priority | Pattern | Where |
|----------|---------|-------|
| P0 | In-flight dedup | `ModelManager.startRefresh()` |
| P0 | Stale-while-revalidate | `ModelManager.getModels()` |
| P1 | Generation counter invalidation | Replace `cache = null` with `staleGeneration++` |
| P1 | Invalidate on reconnect | `gateway.on('reconnected', () => mgr.invalidate())` |
| P2 | Timeout with fallback | `ModelManager.fetchModels()` — race with 750ms timeout |
| P2 | Lazy load guard | Only fetch when model picker opens, not at startup |
| P3 | onAccepted for loading state | Show "loading" in picker during fetch |

---

## Summary Table

| Aspect | Gateway | Matrix/Auto-Reply | VSCode (Current) | VSCode (Recommended) |
|--------|---------|-------------------|-----------------|---------------------|
| **Cache location** | Module-level dual-cache | Lazily loaded per-message | Single `cache` field | Module-level `ModelCacheState` |
| **TTL** | Process lifetime (no TTL) | Per-request (no persistent cache) | Process lifetime | Process lifetime |
| **In-flight dedup** | ✅ Promise reference | ✅ ModelCatalogPromise | ❌ | ✅ Promise reference |
| **Stale-while-revalidate** | ✅ | N/A | ❌ | ✅ |
| **Invalidation trigger** | Config reload | N/A | Called manually | `invalidate()` on reconnect |
| **Invalidation method** | `staleGeneration++` | N/A | `cache = null` | `staleGeneration++` |
| **Error fallback** | Last successful catalog | Empty array | Throws | Last successful catalog |
| **Lazy load** | On-demand with stale check | `needsModelCatalog` guard | On first `getModels()` | On model picker open only |
| **Timeout** | 750ms for `models.list` | N/A | ❌ | 750ms race with stale fallback |
| **hello-ok preload** | N/A | N/A | ❌ | Pre-fetch after connect |
