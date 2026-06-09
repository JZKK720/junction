/**
 * ToolStatusManager — Gateway tool visibility for the VSCode extension.
 *
 * ## Startup (tools.effective)
 * `tools.effective` is an `operator.read` **startup method**. Its result may
 * already be present in the `hello-ok` / connect response `snapshot` field.
 * `load()` checks the snapshot first; only if that data is absent does it
 * issue a separate `tools.effective {}` request over the WebSocket.
 *
 * ## On-demand (tools.catalog)
 * `tools.catalog` is `operator.read` but **NOT a startup method**. It must be
 * explicitly requested. `loadFullCatalog()` sends that request and returns the
 * raw response. This is broader than `tools.effective` — it shows ALL available
 * tool definitions (including custom binary/HTTP search providers), not just
 * the per-session active subset.
 */

import { EffectiveTool, ToolStatus } from '../types/openclaw';
import { GatewayConnection } from './connection';
import { Logger } from '../utils/logger';

/** Shape we expect from a tools.effective response payload. */
interface EffectiveResponse {
  tools?: EffectiveTool[];
  webSearch?: {
    providers?: string[];
    fallbacks?: string[];
    activeProvider?: string;
  };
}

export class ToolStatusManager {
  private status: ToolStatus | null = null;
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Load the effective tool status.
   *
   * @param gateway   Active GatewayConnection (must be connected).
   * @param snapshot  Optional `hello-ok` / connect-response payload. If it
   *                  contains a `tools.effective` result, we use it directly
   *                  and skip the separate WebSocket request.
   */
  async load(gateway: GatewayConnection, snapshot?: any): Promise<void> {
    if (!gateway.isConnected()) {
      this.logger.warn('tools.effective skipped: gateway not connected');
      return;
    }

    // 1. Try snapshot first (hello-ok / connect response may carry it).
    if (snapshot) {
      const effective = this.extractEffective(snapshot);
      if (effective) {
        this.logger.info('Using tools.effective from hello-ok snapshot');
        this.status = effective;
        return;
      }
    }

    // 2. Otherwise issue a dedicated request.
    try {
      this.logger.info('Requesting tools.effective from gateway');
      const response = await gateway.sendRequest('tools.effective', {});
      const payload: EffectiveResponse = response?.payload ?? response;

      this.status = {
        tools: payload?.tools ?? [],
        webSearch: payload?.webSearch ? {
          providers: payload.webSearch.providers ?? [],
          fallbacks: payload.webSearch.fallbacks ?? [],
          activeProvider: payload.webSearch.activeProvider,
        } : undefined,
      };

      this.logger.info('tools.effective loaded', {
        toolCount: this.status.tools.length,
        searchProviders: this.status.webSearch?.providers?.length ?? 0,
      });
    } catch (error) {
      this.logger.warn(
        'tools.effective unavailable — gateway may not be connected or method not available',
        error,
      );
      // Leave status as null; callers check getStatus().
    }
  }

  /**
   * Return the cached effective tool status, or null if not yet loaded /
   * unavailable.
   */
  getStatus(): ToolStatus | null {
    return this.status;
  }

  /**
   * Load the FULL tool catalog (on-demand only — never called at startup).
   *
   * `tools.catalog` returns all registered tool definitions including custom
   * binary/HTTP providers, not just the per-session active subset. This is a
   * significantly larger response; call only when the user explicitly asks.
   *
   * @param gateway  Active GatewayConnection.
   * @returns        The raw catalog payload (shape varies by gateway build).
   */
  async loadFullCatalog(gateway: GatewayConnection): Promise<any> {
    this.logger.info('Requesting tools.catalog from gateway');
    const response = await gateway.sendRequest('tools.catalog', {});
    const catalog = response?.payload ?? response;
    this.logger.info('tools.catalog loaded');
    return catalog;
  }

  /**
   * Try to extract tools.effective data from a snapshot / connect payload.
   * Returns null if the snapshot does not contain recognizable data.
   */
  private extractEffective(snapshot: any): ToolStatus | null {
    // The snapshot shape is gateway-build-dependent.
    // Common paths: snapshot.toolsEffective, snapshot.tools.effective,
    // or the entire snapshot itself is the effective response.
    const candidate =
      snapshot?.toolsEffective ??
      snapshot?.tools?.effective ??
      (snapshot?.tools && Array.isArray(snapshot?.tools) ? snapshot : null);

    if (!candidate || (!candidate.tools && !candidate.webSearch)) {
      return null;
    }

    return {
      tools: Array.isArray(candidate.tools) ? candidate.tools : [],
      webSearch: candidate.webSearch
        ? {
            providers: candidate.webSearch.providers ?? [],
            fallbacks: candidate.webSearch.fallbacks ?? [],
            activeProvider: candidate.webSearch.activeProvider,
          }
        : undefined,
    };
  }
}
