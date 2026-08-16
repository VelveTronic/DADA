import type * as sql from "mssql";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../config";
import { InjectError, type InjectResult } from "../injector";
import type { LogFields, Logger } from "../log";
import type { ClaimedOrder } from "../payload";
import { emptyOrdersTally, ordersCounts, runOrders, type OrdersDeps } from "./orders";

const cfg: BridgeConfig = {
  supabaseUrl: "https://project.supabase.co",
  supabaseServiceRoleKey: "service-key",
  wingestServer: "localhost",
  wingestPort: 50352,
  wingestDb: "wg_test",
  wingestUser: "dada_bridge",
  wingestPassword: "pw",
  erpUser: "SFY",
  can: "B",
  eje: 26,
  alm: "00001",
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
};

const TOKEN = "22222222-2222-4222-8222-222222222222";

function order(orderNumber: number, overrides: Partial<ClaimedOrder> = {}): ClaimedOrder {
  return {
    id: `order-${orderNumber}`,
    order_number: orderNumber,
    claim_token: TOKEN,
    delivery_date: "2026-08-20",
    customer_note: null,
    subtotal_cents: 9995,
    codcli: 3,
    tarcli: 2,
    company_name: "Restaurante Prueba",
    items: [],
    ...overrides,
  };
}

function injected(numped: number, overrides: Partial<InjectResult> = {}): InjectResult {
  return { numped, recovered: false, lineCount: 2, excludedCodarts: [], ...overrides };
}

interface Line {
  level: string;
  message: string;
  fields: LogFields;
}

function recorder(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    log: {
      info: at("INFO"),
      warn: at("WARN"),
      error: at("ERROR"),
      logError: (error, fields = {}) => {
        lines.push({
          level: "ERROR",
          message: error instanceof Error ? error.message : String(error),
          fields,
        });
      },
    },
  };
}

interface Harness {
  deps: OrdersDeps;
  lines: Line[];
  claims: { token: string; limit: number; lease: number }[];
  marks: { orderId: string; token: string; numped: number }[];
  injects: number[];
  connects: number;
  closes: number;
}

function harness(options: {
  orders: ClaimedOrder[];
  inject?: (order: ClaimedOrder) => Promise<InjectResult>;
  mark?: (orderId: string, numped: number) => Promise<boolean>;
}): Harness {
  const { log, lines } = recorder();
  const claims: Harness["claims"] = [];
  const marks: Harness["marks"] = [];
  const injects: number[] = [];
  const state = { connects: 0, closes: 0 };

  const pool = {
    close: () => {
      state.closes++;
      return Promise.resolve();
    },
  } as unknown as sql.ConnectionPool;

  const deps: OrdersDeps = {
    cfg,
    log,
    newToken: () => TOKEN,
    api: {
      claimConfirmed: (token, limit, lease) => {
        claims.push({ token, limit, lease });
        return Promise.resolve(options.orders);
      },
      markInjected: (orderId, token, numped) => {
        marks.push({ orderId, token, numped });
        return options.mark ? options.mark(orderId, numped) : Promise.resolve(true);
      },
    },
    connect: () => {
      state.connects++;
      return Promise.resolve(pool);
    },
    inject: (_pool, _cfg, claimed) => {
      injects.push(claimed.order_number);
      return options.inject
        ? options.inject(claimed)
        : Promise.resolve(injected(500 + claimed.order_number));
    },
  };

  return {
    deps,
    lines,
    claims,
    marks,
    injects,
    get connects() {
      return state.connects;
    },
    get closes() {
      return state.closes;
    },
  };
}

describe("ordersCounts", () => {
  it("emits the five summary fields in the order the plan names them", () => {
    const counts = ordersCounts({
      claimed: 5,
      injected: 3,
      recovered: 1,
      markFailed: 1,
      failed: 1,
    });
    expect(Object.keys(counts)).toEqual([
      "claimed",
      "injected",
      "recovered",
      "markFailed",
      "failed",
    ]);
    expect(counts).toMatchObject({ claimed: 5, failed: 1 });
  });

  it("starts at zero", () => {
    expect(ordersCounts(emptyOrdersTally())).toEqual({
      claimed: 0,
      injected: 0,
      recovered: 0,
      markFailed: 0,
      failed: 0,
    });
  });
});

describe("runOrders", () => {
  it("claims once with the run token and the configured limit and lease", async () => {
    const h = harness({ orders: [] });
    await runOrders(h.deps);
    expect(h.claims).toEqual([{ token: TOKEN, limit: 20, lease: 300 }]);
  });

  it("does not open a SQL connection when there is nothing to inject", async () => {
    // This job runs every minute; an idle run must not touch the ERP.
    const h = harness({ orders: [] });
    const result = await runOrders(h.deps);

    expect(h.connects).toBe(0);
    expect(result).toEqual({
      ok: true,
      counts: { claimed: 0, injected: 0, recovered: 0, markFailed: 0, failed: 0 },
    });
  });

  it("injects sequentially and marks each order with the SAME claim token", async () => {
    const h = harness({ orders: [order(1), order(2), order(3)] });
    const result = await runOrders(h.deps);

    expect(h.injects).toEqual([1, 2, 3]);
    expect(h.marks).toEqual([
      { orderId: "order-1", token: TOKEN, numped: 501 },
      { orderId: "order-2", token: TOKEN, numped: 502 },
      { orderId: "order-3", token: TOKEN, numped: 503 },
    ]);
    expect(result.counts).toMatchObject({ claimed: 3, injected: 3, failed: 0 });
    expect(h.connects).toBe(1);
    expect(h.closes).toBe(1);
  });

  it("marks a dedup recovery with the RECOVERED numped and counts it apart", async () => {
    // The crash-after-inject-before-mark window: the pedido is already there.
    const h = harness({
      orders: [order(7)],
      inject: () => Promise.resolve(injected(999, { recovered: true, lineCount: 0 })),
    });
    const result = await runOrders(h.deps);

    expect(h.marks).toEqual([{ orderId: "order-7", token: TOKEN, numped: 999 }]);
    expect(result.counts).toMatchObject({ injected: 0, recovered: 1, failed: 0 });
    // lineCount is 0 on recovery by contract, and the log says so.
    expect(h.lines.some((l) => l.fields.lineCount === 0)).toBe(true);
  });

  it("logs an inject failure with the full order context and CONTINUES", async () => {
    const h = harness({
      orders: [order(1), order(2), order(3)],
      inject: (claimed) =>
        claimed.order_number === 2
          ? Promise.reject(
              new InjectError("NO_ARTICLE", "codart 9-999 is not in articulo", {
                orderId: "order-2",
                orderNumber: 2,
                ref: "PORTAL-2",
              }),
            )
          : Promise.resolve(injected(500 + claimed.order_number)),
    });
    const result = await runOrders(h.deps);

    expect(h.injects).toEqual([1, 2, 3]);
    expect(h.marks.map((m) => m.orderId)).toEqual(["order-1", "order-3"]);
    expect(result.counts).toMatchObject({ claimed: 3, injected: 2, failed: 1 });

    const failure = h.lines.find((l) => l.fields.stage === "inject");
    expect(failure?.fields).toMatchObject({ orderId: "order-2", orderNumber: 2 });
  });

  it("stays ok when every order fails — the lease is the retry", async () => {
    const h = harness({
      orders: [order(1), order(2)],
      inject: () => Promise.reject(new Error("ERP unreachable mid-run")),
    });
    const result = await runOrders(h.deps);

    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ claimed: 2, failed: 2, injected: 0 });
  });

  it("counts a FALSE mark as markFailed, logs it as an error, and continues", async () => {
    const h = harness({
      orders: [order(1), order(2)],
      mark: (orderId) => Promise.resolve(orderId !== "order-1"),
    });
    const result = await runOrders(h.deps);

    expect(result.counts).toMatchObject({ claimed: 2, injected: 2, markFailed: 1 });
    const alert = h.lines.find((l) => l.message.includes("mark_injected"));
    expect(alert?.level).toBe("ERROR");
    expect(alert?.fields).toMatchObject({ orderId: "order-1", numped: 501 });
  });

  it("counts a THROWING mark the same way — the pedido exists either way", async () => {
    const h = harness({
      orders: [order(1), order(2)],
      mark: (orderId) =>
        orderId === "order-1"
          ? Promise.reject(new Error("socket hang up"))
          : Promise.resolve(true),
    });
    const result = await runOrders(h.deps);

    expect(result.counts).toMatchObject({ claimed: 2, injected: 2, markFailed: 1, failed: 0 });
    expect(h.lines.some((l) => l.fields.stage === "mark_injected")).toBe(true);
  });

  it("keeps injected + recovered + failed equal to claimed", async () => {
    const h = harness({
      orders: [order(1), order(2), order(3), order(4)],
      inject: (claimed) => {
        if (claimed.order_number === 1) return Promise.reject(new Error("bad line"));
        if (claimed.order_number === 2) {
          return Promise.resolve(injected(600, { recovered: true, lineCount: 0 }));
        }
        return Promise.resolve(injected(500 + claimed.order_number));
      },
      mark: () => Promise.resolve(false),
    });
    const { counts } = await runOrders(h.deps);

    expect(
      Number(counts.injected) + Number(counts.recovered) + Number(counts.failed),
    ).toBe(counts.claimed);
    // markFailed overlaps the pedidos that DO exist, so it is not part of that sum.
    expect(counts.markFailed).toBe(3);
  });

  it("closes the pool even when an order throws", async () => {
    const h = harness({
      orders: [order(1)],
      inject: () => Promise.reject(new Error("boom")),
    });
    await runOrders(h.deps);
    expect(h.closes).toBe(1);
  });

  it("logs the excluded codarts on an order that had some", async () => {
    const h = harness({
      orders: [order(1)],
      inject: () => Promise.resolve(injected(501, { excludedCodarts: ["9-001", "9-002"] })),
    });
    await runOrders(h.deps);

    const line = h.lines.find((l) => l.message === "injected");
    expect(line?.fields.excluded).toBe("9-001,9-002");
  });
});
