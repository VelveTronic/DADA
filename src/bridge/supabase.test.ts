import { describe, expect, it } from "vitest";
import {
  SupabaseHttpError,
  SupabaseNetworkError,
  SupabasePayloadError,
  createBridgeSupabase,
  parseContentRangeTotal,
} from "./supabase";

const cfg = {
  supabaseUrl: "https://project.supabase.co",
  supabaseServiceRoleKey: "sb_secret_service_role",
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
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

describe("claimConfirmed", () => {
  it("posts the RPC arguments and returns the claimed orders", async () => {
    const { api, calls } = client([json([ORDER])]);
    const orders = await api.claimConfirmed(ORDER.claim_token, 20, 300);

    expect(orders).toHaveLength(1);
    expect(orders[0].order_number).toBe(4242);
    expect(calls[0].url).toBe(
      "https://project.supabase.co/rest/v1/rpc/bridge_claim_confirmed",
    );
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_claim_token: ORDER.claim_token,
      p_limit: 20,
      p_lease_seconds: 300,
    });
  });

  it("authenticates with the service-role key and never puts it in the URL", async () => {
    const { api, calls } = client([json([])]);
    await api.claimConfirmed(ORDER.claim_token, 20, 300);
    expect(calls[0].headers.apikey).toBe(cfg.supabaseServiceRoleKey);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${cfg.supabaseServiceRoleKey}`);
    expect(calls[0].url).not.toContain(cfg.supabaseServiceRoleKey);
  });

  it("refuses a payload that is not the claim contract", async () => {
    await expect(client([json({ nope: true })]).api.claimConfirmed("t", 1, 30)).rejects.toBeInstanceOf(
      SupabasePayloadError,
    );
    await expect(
      client([json([{ id: "x", order_number: 1, claim_token: "t", codcli: 3 }])]).api.claimConfirmed(
        "t",
        1,
        30,
      ),
    ).rejects.toThrow(/items/);
  });

  it("refuses an order whose company has no codcli", async () => {
    const { api } = client([json([{ ...ORDER, codcli: null }])]);
    await expect(api.claimConfirmed("t", 1, 30)).rejects.toThrow(/codcli/);
  });
});

describe("marks", () => {
  it("returns the RPC's boolean verbatim — false is the caller's alert", async () => {
    expect(await client([json(true)]).api.markInjected("id", "token", 501)).toBe(true);
    expect(await client([json(false)]).api.markInjected("id", "token", 501)).toBe(false);
    expect(await client([json(true)]).api.markAlbaran("id", 900)).toBe(true);
  });

  it("passes the claim token through, which is what binds the mark to the claim", async () => {
    const { api, calls } = client([json(true)]);
    await api.markInjected("order-id", "claim-token", 501);
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      p_order_id: "order-id",
      p_claim_token: "claim-token",
      p_numped: 501,
    });
  });

  it("refuses a non-boolean answer rather than coercing it", async () => {
    await expect(client([json("true")]).api.markInjected("id", "t", 1)).rejects.toBeInstanceOf(
      SupabasePayloadError,
    );
  });
});

describe("listInjected", () => {
  it("selects only id and numped", async () => {
    const { api, calls } = client([json([{ id: "a", numped: 501 }, { id: "b", numped: null }])]);
    expect(await api.listInjected()).toEqual([
      { id: "a", numped: 501 },
      { id: "b", numped: null },
    ]);
    expect(calls[0].url).toBe(
      "https://project.supabase.co/rest/v1/orders?status=eq.injected&select=id,numped",
    );
  });
});

describe("transport", () => {
  it("retries once when the request never got an answer", async () => {
    const { api, calls } = client([new TypeError("fetch failed"), json([])]);
    await expect(api.claimConfirmed("t", 1, 30)).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second network failure, naming the path", async () => {
    const { api, calls } = client([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const error = await api.claimConfirmed("t", 1, 30).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseNetworkError);
    expect((error as SupabaseNetworkError).path).toContain("bridge_claim_confirmed");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a status code — a second claim would lease a second batch", async () => {
    const { api, calls } = client([json({ message: "boom" }, 500)]);
    const error = await api.claimConfirmed("t", 1, 30).catch((e: unknown) => e);
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
  function counted(total: string): Response {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Range": total },
    });
  }

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
