/**
 * The Supabase half of the bridge: raw `fetch` against PostgREST with the
 * service-role key.
 *
 * Raw fetch rather than `@supabase/supabase-js` because the bridge ships as one
 * esbuild bundle onto a Windows server: every dependency is code the owner has
 * to trust and we have to rebuild, and the five calls below are three RPCs, one
 * table read and one upsert. The client library would add a megabyte to buy
 * nothing.
 *
 * Everything here is service-role. The three `bridge_*` functions are EXECUTE-
 * granted to `service_role` alone (see migration 20260815101406), so no other
 * key can reach them — which is also why the key never appears in a log line,
 * an error body, or a URL.
 */
import type { ClaimedOrder } from "./payload";

/** The server answered, and the answer was not a success. Carries status + body. */
export class SupabaseHttpError extends Error {
  readonly code = "SUPABASE_HTTP";
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`${path} responded ${status}: ${body}`);
    this.name = "SupabaseHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** The request never got an answer: DNS, TCP, TLS, or our own timeout. */
export class SupabaseNetworkError extends Error {
  readonly code = "SUPABASE_NETWORK";
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `${path} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "SupabaseNetworkError";
    this.path = path;
  }
}

/** The answer parsed, but is not the shape the contract promises. */
export class SupabasePayloadError extends Error {
  readonly code = "SUPABASE_PAYLOAD";
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path} returned an unexpected payload: ${detail}`);
    this.name = "SupabasePayloadError";
    this.path = path;
  }
}

export interface InjectedOrderRef {
  id: string;
  numped: number | null;
}

export interface HeartbeatRow {
  job: string;
  last_run_at: string;
  ok: boolean;
  detail: unknown;
}

export interface BridgeSupabase {
  claimConfirmed(
    claimToken: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedOrder[]>;
  markInjected(orderId: string, claimToken: string, numped: number): Promise<boolean>;
  markAlbaran(orderId: string, numalb: number): Promise<boolean>;
  listInjected(): Promise<InjectedOrderRef[]>;
  /** False when `bridge_status` does not exist yet (Task 3 adds it). */
  heartbeat(row: HeartbeatRow): Promise<boolean>;
}

export interface SupabaseClientOptions {
  timeoutMs?: number;
  /** Pause before the single retry. Zero in tests. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Enough of an error body to diagnose; not enough to flood a log file. */
const MAX_ERROR_BODY = 2_000;

/**
 * PostgREST's code for "no such table in the schema cache" — what `bridge_status`
 * answers with between Task 1 and the Task 3 migration that creates it.
 */
const UNDEFINED_TABLE_CODES = ["PGRST205", "42P01"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBridgeSupabase(
  cfg: { supabaseUrl: string; supabaseServiceRoleKey: string },
  options: SupabaseClientOptions = {},
): BridgeSupabase {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = fetch,
  } = options;

  const headers = {
    apikey: cfg.supabaseServiceRoleKey,
    Authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  /**
   * One HTTP round trip with a hard deadline and ONE retry.
   *
   * The retry covers only a request that never got an answer — a dropped
   * connection or our own timeout — because that is the case where the ERP
   * server's flaky link, not the database, is the problem. It is deliberately
   * not a retry on 5xx: a repeated `bridge_claim_confirmed` would lease a second
   * batch of orders while the first is still out, and the caller can see and
   * decide about a status code, which it cannot do about a socket error.
   *
   * The known cost: if the FIRST attempt actually reached the database and only
   * the response was lost, the retry sees the world already changed —
   * `markInjected` then returns false, which the orders job reports as an
   * alertable mark failure rather than silently mis-recording anything.
   */
  async function send(
    path: string,
    init: { method: string; body?: string; extraHeaders?: Record<string, string> },
  ): Promise<{ status: number; text: string }> {
    const url = `${cfg.supabaseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: init.method,
          headers: { ...headers, ...init.extraHeaders },
          body: init.body,
          signal: controller.signal,
        });
        const text = await response.text();
        return { status: response.status, text };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SupabaseNetworkError(path, lastError);
  }

  function parseJson(path: string, text: string): unknown {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SupabasePayloadError(path, `not JSON: ${text.slice(0, 200)}`);
    }
  }

  async function call(
    path: string,
    init: { method: string; body?: string; extraHeaders?: Record<string, string> },
  ): Promise<unknown> {
    const { status, text } = await send(path, init);
    if (status < 200 || status >= 300) {
      throw new SupabaseHttpError(path, status, text.slice(0, MAX_ERROR_BODY));
    }
    return parseJson(path, text);
  }

  /**
   * `bridge_claim_confirmed` returns jsonb, so PostgREST hands back the array
   * itself. The shape check is not paranoia about our own migration: it is what
   * turns "cannot read property items of undefined" three functions later into
   * one line naming the call that lied.
   */
  function assertClaimedOrders(path: string, value: unknown): ClaimedOrder[] {
    if (!Array.isArray(value)) {
      throw new SupabasePayloadError(path, `expected an array, got ${typeof value}`);
    }
    for (const [index, row] of value.entries()) {
      const order = row as Partial<ClaimedOrder> | null;
      if (!order || typeof order !== "object") {
        throw new SupabasePayloadError(path, `row ${index} is not an object`);
      }
      if (typeof order.id !== "string" || typeof order.order_number !== "number") {
        throw new SupabasePayloadError(path, `row ${index} has no id/order_number`);
      }
      if (typeof order.claim_token !== "string") {
        throw new SupabasePayloadError(
          path,
          `order ${order.order_number} has no claim_token`,
        );
      }
      if (typeof order.codcli !== "number") {
        throw new SupabasePayloadError(
          path,
          `order ${order.order_number} has no codcli — the claim must exclude companies without one`,
        );
      }
      if (!Array.isArray(order.items)) {
        throw new SupabasePayloadError(path, `order ${order.order_number} has no items`);
      }
    }
    return value as ClaimedOrder[];
  }

  function assertBoolean(path: string, value: unknown): boolean {
    if (typeof value !== "boolean") {
      throw new SupabasePayloadError(path, `expected a boolean, got ${JSON.stringify(value)}`);
    }
    return value;
  }

  return {
    async claimConfirmed(claimToken, limit, leaseSeconds) {
      const path = "/rest/v1/rpc/bridge_claim_confirmed";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_claim_token: claimToken,
          p_limit: limit,
          p_lease_seconds: leaseSeconds,
        }),
      });
      return assertClaimedOrders(path, value);
    },

    async markInjected(orderId, claimToken, numped) {
      const path = "/rest/v1/rpc/bridge_mark_injected";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_order_id: orderId,
          p_claim_token: claimToken,
          p_numped: numped,
        }),
      });
      return assertBoolean(path, value);
    },

    async markAlbaran(orderId, numalb) {
      const path = "/rest/v1/rpc/bridge_mark_albaran";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({ p_order_id: orderId, p_numalb: numalb }),
      });
      return assertBoolean(path, value);
    },

    async listInjected() {
      const path = "/rest/v1/orders?status=eq.injected&select=id,numped";
      const value = await call(path, { method: "GET" });
      if (!Array.isArray(value)) {
        throw new SupabasePayloadError(path, `expected an array, got ${typeof value}`);
      }
      return value.map((row, index) => {
        const order = row as { id?: unknown; numped?: unknown };
        if (typeof order.id !== "string") {
          throw new SupabasePayloadError(path, `row ${index} has no id`);
        }
        return {
          id: order.id,
          numped: typeof order.numped === "number" ? order.numped : null,
        };
      });
    },

    /**
     * Upsert one row per job. Tolerant of a missing table on purpose: Tasks 1
     * and 2 run against a database that does not have `bridge_status` yet, and a
     * heartbeat is telemetry — it must never be the reason a run that already
     * injected orders reports failure.
     */
    async heartbeat(row) {
      const path = "/rest/v1/bridge_status?on_conflict=job";
      const { status, text } = await send(path, {
        method: "POST",
        body: JSON.stringify(row),
        extraHeaders: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
      if (status >= 200 && status < 300) return true;
      if (status === 404) {
        const parsed = parseJson(path, text) as { code?: unknown } | null;
        if (
          !parsed ||
          typeof parsed.code !== "string" ||
          UNDEFINED_TABLE_CODES.includes(parsed.code)
        ) {
          return false;
        }
      }
      throw new SupabaseHttpError(path, status, text.slice(0, MAX_ERROR_BODY));
    },
  };
}
