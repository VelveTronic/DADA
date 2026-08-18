import { describe, expect, it } from "vitest";
import { BRIDGE_SUPABASE_ORIGIN, BridgeConfigError } from "./config";
import {
  SupabaseHttpError,
  SupabaseNetworkError,
  SupabasePayloadError,
  createBridgeSupabase,
  parseContentRangeTotal,
} from "./supabase";

const cfg = {
  supabaseUrl: BRIDGE_SUPABASE_ORIGIN,
  supabaseServiceRoleKey: "sb_secret_service_role",
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
}

/**
 * A fetch stand-in that replays canned outcomes in order and records what it was
 * asked for. An outcome is either a Response or an Error to throw (a network
 * failure), which is the distinction the retry rule turns on.
 */
function fakeFetch(outcomes: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const queue = [...outcomes];
  const calls: Recorded[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
      redirect: init.redirect,
    });
    const next = queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (!next) throw new Error("fakeFetch ran out of outcomes");
    return Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function counted(total: string): Response {
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json", "Content-Range": total },
  });
}

function client(outcomes: (Response | Error)[]) {
  const { fetchImpl, calls } = fakeFetch(outcomes);
  return {
    api: createBridgeSupabase(cfg, { fetchImpl, retryDelayMs: 0 }),
    calls,
  };
}

const ORDER = {
  id: "11111111-1111-4111-8111-111111111111",
  order_number: 4242,
  claim_token: "22222222-2222-4222-8222-222222222222",
  delivery_date: "2026-08-20",
  customer_note: null,
  subtotal_cents: 9995,
  codcli: 3,
  tarcli: 2,
  company_name: "Restaurante Prueba",
  items: [],
};

describe("service-role destination", () => {
  it("rejects a hand-built client for any unpinned origin before fetch", () => {
    expect(() =>
      createBridgeSupabase({
        ...cfg,
        supabaseUrl: "https://attacker.example",
      }),
    ).toThrow(BridgeConfigError);
  });
});

describe("claimConfirmed", () => {
  it("posts the RPC arguments and returns the claimed orders", async () => {
    const { api, calls } = client([json([ORDER])]);
    const orders = await api.claimConfirmed(ORDER.claim_token, 20, 300, null);

    expect(orders).toHaveLength(1);
    expect(orders[0].order_number).toBe(4242);
    expect(calls[0].url).toBe(
      `${BRIDGE_SUPABASE_ORIGIN}/rest/v1/rpc/bridge_claim_confirmed`,
    );
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_claim_token: ORDER.claim_token,
      p_limit: 20,
      p_lease_seconds: 300,
      p_order_id: null,
    });
  });

  it("posts a verified historical Pedido identity to the backfill RPC", async () => {
    const { api, calls } = client([json(true)]);
    await api.backfillOrderIdentity("order-id", "A", 25, 501);
    expect(calls[0].url).toBe(
      `${BRIDGE_SUPABASE_ORIGIN}/rest/v1/rpc/bridge_backfill_order_identity`,
    );
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_order_id: "order-id",
      p_can: "A",
      p_eje: 25,
      p_numped: 501,
    });
  });

  it("passes a supervised historical order target to the claim RPC", async () => {
    const { api, calls } = client([json([])]);
    await api.claimConfirmed(ORDER.claim_token, 1, 300, ORDER.id);

    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_claim_token: ORDER.claim_token,
      p_limit: 1,
      p_lease_seconds: 300,
      p_order_id: ORDER.id,
    });
  });

  it("authenticates with the service-role key and never puts it in the URL", async () => {
    const { api, calls } = client([json([])]);
    await api.claimConfirmed(ORDER.claim_token, 20, 300, null);
    expect(calls[0].headers.apikey).toBe(cfg.supabaseServiceRoleKey);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${cfg.supabaseServiceRoleKey}`);
    expect(calls[0].url).not.toContain(cfg.supabaseServiceRoleKey);
    expect(calls[0].redirect).toBe("error");
  });

  it("refuses a payload that is not the claim contract", async () => {
    await expect(
      client([json({ nope: true })]).api.claimConfirmed("t", 1, 30, null),
    ).rejects.toBeInstanceOf(SupabasePayloadError);
    await expect(
      client([json([{ id: "x", order_number: 1, claim_token: "t", codcli: 3 }])]).api.claimConfirmed(
        "t",
        1,
        30,
        null,
      ),
    ).rejects.toThrow(/items/);
  });

  it("refuses an order whose company has no codcli", async () => {
    const { api } = client([json([{ ...ORDER, codcli: null }])]);
    await expect(api.claimConfirmed("t", 1, 30, null)).rejects.toThrow(/codcli/);
  });
});

describe("marks", () => {
  it("returns the RPC's boolean verbatim — false is the caller's alert", async () => {
    expect(await client([json(true)]).api.markInjected("id", "token", "B", 26, 501)).toBe(
      true,
    );
    expect(await client([json(false)]).api.markInjected("id", "token", "B", 26, 501)).toBe(
      false,
    );
    expect(await client([json(true)]).api.markAlbaran("id", "B", 27, 900)).toBe(true);
  });

  it("passes the claim token through, which is what binds the mark to the claim", async () => {
    const { api, calls } = client([json(true)]);
    await api.markInjected("order-id", "claim-token", "B", 26, 501);
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_order_id: "order-id",
      p_claim_token: "claim-token",
      p_can: "B",
      p_eje: 26,
      p_numped: 501,
    });
  });

  it("passes the independent Albarán identity to the mark RPC", async () => {
    const { api, calls } = client([json(true)]);
    await api.markAlbaran("order-id", "B", 27, 900);
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_order_id: "order-id",
      p_can: "B",
      p_eje: 27,
      p_numalb: 900,
    });
  });

  it("refuses a non-boolean answer rather than coercing it", async () => {
    await expect(
      client([json("true")]).api.markInjected("id", "t", "B", 26, 1),
    ).rejects.toBeInstanceOf(SupabasePayloadError);
  });

  it("posts a classified order failure and maps the atomic outcome", async () => {
    const { api, calls } = client([
      json({ marked: true, outcome: "requeued", attempt_count: 2 }),
    ]);

    await expect(
      api.markOrderFailed(
        "order-id",
        "claim-token",
        "PREFLIGHT_FAILED",
        "ERP timed out",
        true,
      ),
    ).resolves.toEqual({ marked: true, outcome: "requeued", attemptCount: 2 });
    expect(calls[0].url).toBe(
      `${BRIDGE_SUPABASE_ORIGIN}/rest/v1/rpc/bridge_mark_order_failed`,
    );
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_order_id: "order-id",
      p_claim_token: "claim-token",
      p_error_code: "PREFLIGHT_FAILED",
      p_error_message: "ERP timed out",
      p_retryable: true,
    });
  });

  it("accepts the terminal and stale-claim failure outcomes", async () => {
    await expect(
      client([json({ marked: true, outcome: "terminal", attempt_count: 1 })]).api
        .markOrderFailed("id", "token", "ALL_LINES_EXCLUDED", "nothing to inject", false),
    ).resolves.toEqual({ marked: true, outcome: "terminal", attemptCount: 1 });

    await expect(
      client([json({ marked: false, outcome: "stale_claim", attempt_count: null })]).api
        .markOrderFailed("id", "token", "PREFLIGHT_FAILED", "timeout", true),
    ).resolves.toEqual({ marked: false, outcome: "stale_claim", attemptCount: null });
  });

  it("refuses malformed or internally inconsistent failure-mark results", async () => {
    await expect(
      client([json({ marked: true, outcome: "later", attempt_count: 1 })]).api
        .markOrderFailed("id", "token", "X", "x", true),
    ).rejects.toBeInstanceOf(SupabasePayloadError);
    await expect(
      client([json({ marked: false, outcome: "terminal", attempt_count: 1 })]).api
        .markOrderFailed("id", "token", "X", "x", false),
    ).rejects.toBeInstanceOf(SupabasePayloadError);
    await expect(
      client([json({ marked: true, outcome: "terminal", attempt_count: null })]).api
        .markOrderFailed("id", "token", "X", "x", false),
    ).rejects.toBeInstanceOf(SupabasePayloadError);
  });
});

describe("listInjected", () => {
  it("selects and maps the complete persisted ERP identity", async () => {
    const { api, calls } = client([
      json([
        { id: "a", order_number: 4242, erp_can: "B", erp_eje: 26, numped: 501 },
        { id: "b", order_number: 4243, erp_can: null, erp_eje: null, numped: null },
      ]),
    ]);
    expect(await api.listInjected()).toEqual([
      { id: "a", orderNumber: 4242, erpCan: "B", erpEje: 26, numped: 501 },
      { id: "b", orderNumber: 4243, erpCan: null, erpEje: null, numped: null },
    ]);
    expect(calls[0].url).toBe(
      `${BRIDGE_SUPABASE_ORIGIN}/rest/v1/orders?status=eq.injected&select=id,order_number,erp_can,erp_eje,numped`,
    );
  });

  it("fails closed on missing, coerced or non-normalised identity fields", async () => {
    for (const row of [
      { id: "a", erp_can: "B", numped: 501 },
      { id: "a", erp_can: "B", erp_eje: "26", numped: 501 },
      { id: "a", erp_can: " b", erp_eje: 26, numped: 501 },
      { id: "a", erp_can: "b", erp_eje: 26, numped: 501 },
      { id: "a", erp_can: "B", erp_eje: 26, numped: 501.5 },
    ]) {
      await expect(client([json([row])]).api.listInjected()).rejects.toBeInstanceOf(
        SupabasePayloadError,
      );
    }
  });
});

describe("transport", () => {
  it("retries once when the request never got an answer", async () => {
    const { api, calls } = client([new TypeError("fetch failed"), json([])]);
    await expect(api.claimConfirmed("t", 1, 30, null)).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second network failure, naming the path", async () => {
    const { api, calls } = client([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const error = await api.claimConfirmed("t", 1, 30, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseNetworkError);
    expect((error as SupabaseNetworkError).path).toContain("bridge_claim_confirmed");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a status code — a second claim would lease a second batch", async () => {
    const { api, calls } = client([json({ message: "boom" }, 500)]);
    const error = await api.claimConfirmed("t", 1, 30, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseHttpError);
    expect((error as SupabaseHttpError).status).toBe(500);
    expect((error as SupabaseHttpError).body).toContain("boom");
    expect(calls).toHaveLength(1);
  });

  it("aborts a request that outlives the timeout", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const api = createBridgeSupabase(cfg, { fetchImpl, timeoutMs: 5, retryDelayMs: 0 });
    await expect(api.listInjected()).rejects.toBeInstanceOf(SupabaseNetworkError);
  });
});

describe("heartbeat", () => {
  const row = { job: "orders", last_run_at: "2026-08-16T08:00:00Z", ok: true, detail: {} };

  it("upserts on the job key", async () => {
    const { api, calls } = client([new Response(null, { status: 204 })]);
    expect(await api.heartbeat(row)).toBe(true);
    expect(calls[0].url).toContain("/rest/v1/bridge_status?on_conflict=job");
    expect(calls[0].headers.Prefer).toBe("resolution=merge-duplicates,return=minimal");
  });

  it("is false, not fatal, while bridge_status does not exist yet", async () => {
    // Task 3 adds the table; Tasks 1 and 2 must still run before it lands.
    const { api } = client([json({ code: "PGRST205", message: "Could not find the table" }, 404)]);
    expect(await api.heartbeat(row)).toBe(false);
  });

  it("still raises a real failure", async () => {
    const { api } = client([json({ message: "permission denied" }, 401)]);
    await expect(api.heartbeat(row)).rejects.toBeInstanceOf(SupabaseHttpError);
  });
});

describe("parseContentRangeTotal", () => {
  it("reads the total off a page", () => {
    expect(parseContentRangeTotal("0-24/3573")).toBe(3573);
  });

  it("reads the total off an empty page, which is what limit=0 returns", () => {
    expect(parseContentRangeTotal("*/3573")).toBe(3573);
  });

  it("is null when nothing was counted", () => {
    expect(parseContentRangeTotal("*/*")).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal("")).toBeNull();
    expect(parseContentRangeTotal("nonsense")).toBeNull();
  });

  it("reads zero as zero, not as absent", () => {
    expect(parseContentRangeTotal("*/0")).toBe(0);
  });
});

describe("patchProduct", () => {
  const patch = { price_1_cents: 1999, erp_synced_at: "2026-08-16T04:30:00.000Z" };

  it("PATCHes one codart and asks for the row back", async () => {
    const { api, calls } = client([json([{ codart: "4-007" }])]);
    expect(await api.patchProduct("4-007", patch)).toBe(true);

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/rest/v1/products?codart=eq.4-007");
    expect(calls[0].url).toContain("select=codart");
    expect(calls[0].headers.Prefer).toBe("return=representation");
    expect(calls[0].body).toBe(JSON.stringify(patch));
  });

  it("is false when no product carries that codart", async () => {
    // The distinction PostgREST's 204 cannot make, and the whole notInPortal count.
    const { api } = client([json([])]);
    expect(await api.patchProduct("9-999", patch)).toBe(false);
  });

  it("escapes a codart rather than pasting it into the query string", async () => {
    const { api, calls } = client([json([])]);
    await api.patchProduct("A&B 1", patch);
    expect(calls[0].url).toContain("codart=eq.A%26B+1");
  });

  it("raises a real failure", async () => {
    const { api } = client([json({ message: "permission denied" }, 403)]);
    await expect(api.patchProduct("4-007", patch)).rejects.toBeInstanceOf(SupabaseHttpError);
  });
});

describe("countProducts", () => {
  it("asks for an exact count and no rows", async () => {
    const { api, calls } = client([counted("*/102")]);
    expect(await api.countProducts({ price_1_cents: "is.null" })).toBe(102);

    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("price_1_cents=is.null");
    expect(calls[0].url).toContain("limit=0");
    expect(calls[0].headers.Prefer).toBe("count=exact");
  });

  it("encodes a PostgREST or() filter", async () => {
    const { api, calls } = client([counted("*/1")]);
    await api.countProducts({ or: "(price_1_cents.not.is.null,price_2_cents.not.is.null)" });
    expect(calls[0].url).toContain("or=%28price_1_cents.not.is.null%2Cprice_2_cents.not.is.null%29");
  });

  it("is null when the server withheld the count", async () => {
    const { api } = client([counted("*/*")]);
    expect(await api.countProducts({})).toBeNull();
  });

  it("raises a real failure", async () => {
    const { api } = client([json({ message: "boom" }, 500)]);
    await expect(api.countProducts({})).rejects.toBeInstanceOf(SupabaseHttpError);
  });
});

describe("countOrders", () => {
  it("asks for an exact filtered count without downloading order rows", async () => {
    const { api, calls } = client([counted("*/7")]);
    await expect(
      api.countOrders({
        status: "eq.confirmed",
        bridge_attempt_count: "gt.0",
      }),
    ).resolves.toBe(7);

    expect(calls[0]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({ Prefer: "count=exact" }),
    });
    expect(calls[0].url).toBe(
      `${BRIDGE_SUPABASE_ORIGIN}/rest/v1/orders?status=eq.confirmed&bridge_attempt_count=gt.0&select=id&limit=0`,
    );
  });

  it("returns null when the backlog count cannot be proven", async () => {
    const { api } = client([counted("*/*")]);
    await expect(api.countOrders({ status: "eq.processing" })).resolves.toBeNull();
  });

  it("preserves an exact zero instead of treating it as a withheld count", async () => {
    const { api } = client([counted("*/0")]);
    await expect(api.countOrders({ status: "eq.bridge_failed" })).resolves.toBe(0);
  });

  it("raises a real failure", async () => {
    const { api } = client([json({ message: "permission denied" }, 403)]);
    await expect(api.countOrders({ status: "eq.processing" })).rejects.toBeInstanceOf(
      SupabaseHttpError,
    );
  });
});
