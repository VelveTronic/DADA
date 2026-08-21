import type * as sql from "mssql";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../config";
import {
  AllLinesExcludedError,
  ERP_COMMIT_OUTCOME_UNKNOWN,
  ERP_ROLLBACK_FAILED,
  InjectError,
  type InjectResult,
} from "../injector";
import type { LogFields, Logger } from "../log";
import type { ClaimedOrder } from "../payload";
import type { OrderFailureMark } from "../supabase";
import {
  BATCH_ABORTED_UNSAFE_ERP_CONNECTION,
  MAX_FAILURE_CODE_LENGTH,
  MAX_FAILURE_MESSAGE_LENGTH,
  EjeYearMismatchError,
  classifyOrderFailure,
  emptyOrdersTally,
  madridEjeAt,
  ordersCounts,
  runOrders,
  type OrdersDeps,
} from "./orders";

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
  lotAllowExpired: false,
  lotExpiredMaxDays: 0,
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
  allowHistoricalEje: false,
  historicalOrderId: null,
};

const TOKEN = "22222222-2222-4222-8222-222222222222";
const HISTORICAL_ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  return {
    can: "B",
    eje: 26,
    numped,
    recovered: false,
    lineCount: 2,
    excludedCodarts: [],
    lotFlags: [],
    ...overrides,
  };
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
  claims: { token: string; limit: number; lease: number; orderId: string | null }[];
  marks: { orderId: string; token: string; can: string; eje: number; numped: number }[];
  failureMarks: {
    orderId: string;
    token: string;
    code: string;
    message: string;
    retryable: boolean;
  }[];
  backlogQueries: Record<string, string>[];
  events: string[];
  injects: number[];
  connects: number;
  closes: number;
}

function harness(options: {
  orders: ClaimedOrder[];
  inject?: (order: ClaimedOrder) => Promise<InjectResult>;
  mark?: (orderId: string, numped: number) => Promise<boolean>;
  markFailure?: (
    orderId: string,
    code: string,
    retryable: boolean,
  ) => Promise<OrderFailureMark>;
  cfg?: Partial<BridgeConfig>;
  now?: () => Date;
  claim?: (orderId: string | null, limit: number) => Promise<ClaimedOrder[]>;
  countOrders?: (filters: Record<string, string>) => Promise<number | null>;
}): Harness {
  const { log, lines } = recorder();
  const claims: Harness["claims"] = [];
  const marks: Harness["marks"] = [];
  const failureMarks: Harness["failureMarks"] = [];
  const backlogQueries: Record<string, string>[] = [];
  const events: string[] = [];
  const injects: number[] = [];
  const state = { connects: 0, closes: 0 };

  const pool = {
    close: () => {
      state.closes++;
      events.push("pool_close");
      return Promise.resolve();
    },
  } as unknown as sql.ConnectionPool;

  const deps: OrdersDeps = {
    cfg: { ...cfg, ...options.cfg },
    log,
    newToken: () => TOKEN,
    now: options.now ?? (() => new Date("2026-08-17T10:00:00.000Z")),
    api: {
      claimConfirmed: (token, limit, lease, orderId) => {
        claims.push({ token, limit, lease, orderId });
        if (options.claim) return options.claim(orderId, limit);
        const eligible =
          orderId === null
            ? options.orders
            : options.orders.filter((claimed) => claimed.id === orderId);
        return Promise.resolve(eligible.slice(0, limit));
      },
      markInjected: (orderId, token, can, eje, numped) => {
        events.push(`mark_injected:${orderId}`);
        marks.push({ orderId, token, can, eje, numped });
        return options.mark ? options.mark(orderId, numped) : Promise.resolve(true);
      },
      markOrderFailed: (orderId, token, code, message, retryable) => {
        events.push(`mark_failed:${orderId}`);
        failureMarks.push({ orderId, token, code, message, retryable });
        return options.markFailure
          ? options.markFailure(orderId, code, retryable)
          : Promise.resolve({
              marked: true,
              outcome: retryable ? "requeued" : "terminal",
              attemptCount: 1,
            });
      },
      countOrders: (filters) => {
        backlogQueries.push({ ...filters });
        events.push(`count:${filters.status ?? "unknown"}`);
        return options.countOrders ? options.countOrders(filters) : Promise.resolve(0);
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
    failureMarks,
    backlogQueries,
    events,
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
  it("emits the success, failure-state and alert counters in a stable order", () => {
    const counts = ordersCounts({
      claimed: 5,
      injected: 3,
      recovered: 1,
      markFailed: 1,
      failed: 1,
      requeued: 0,
      terminal: 1,
      failureMarkFailed: 0,
      manualRequired: 2,
      retryPending: 3,
      processingPending: 4,
      backlogCountError: 1,
      lotMissing: 2,
      lotExpired: 0,
      lotBlocked: 3,
    });
    expect(Object.keys(counts)).toEqual([
      "claimed",
      "injected",
      "recovered",
      "failed",
      "requeued",
      "terminal",
      "markFailed",
      "failureMarkFailed",
      "manualRequired",
      "retryPending",
      "processingPending",
      "backlogCountError",
      // Appended after the existing twelve: staff read this card by position,
      // so a new counter goes on the end and never in the middle.
      "lotMissing",
      "lotExpired",
      "lotBlocked",
    ]);
    expect(counts).toMatchObject({ claimed: 5, failed: 1, lotMissing: 2, lotBlocked: 3 });
  });

  it("starts at zero", () => {
    expect(ordersCounts(emptyOrdersTally())).toEqual({
      claimed: 0,
      injected: 0,
      recovered: 0,
      markFailed: 0,
      failed: 0,
      requeued: 0,
      terminal: 0,
      failureMarkFailed: 0,
      manualRequired: 0,
      retryPending: 0,
      processingPending: 0,
      backlogCountError: 0,
      lotMissing: 0,
      lotExpired: 0,
      lotBlocked: 0,
    });
  });
});

describe("classifyOrderFailure", () => {
  it("keeps an injector's stable code and permanent disposition", () => {
    const failure = classifyOrderFailure(
      new InjectError(
        "ERP_ARTICLE_NOT_FOUND",
        "codart 9-999 is not in articulo",
        { orderId: "order-2", orderNumber: 2, ref: "PORTAL-2" },
        { retryable: false },
      ),
    );

    expect(failure).toMatchObject({
      code: "ERP_ARTICLE_NOT_FOUND",
      retryable: false,
    });
  });

  it("conservatively retries unknown infrastructure errors", () => {
    expect(classifyOrderFailure(new Error("deadlock victim"))).toEqual({
      code: "UNEXPECTED_INJECT_ERROR",
      message: "deadlock victim",
      retryable: true,
    });
  });

  it("redacts secrets, removes control characters and caps stored messages", () => {
    const failure = classifyOrderFailure(
      new Error(`socket\npassword=${cfg.wingestPassword} ${"x".repeat(2_000)}`),
      [cfg.wingestPassword],
    );

    expect(failure.message).not.toContain(cfg.wingestPassword);
    expect(failure.message).not.toContain("\n");
    expect(failure.message.length).toBe(MAX_FAILURE_MESSAGE_LENGTH);
  });

  it("normalises and caps an externally supplied error code", () => {
    const failure = classifyOrderFailure(
      new InjectError(
        ` strange-code-${"x".repeat(200)} `,
        "bad",
        { orderId: "id", orderNumber: 1, ref: "PORTAL-1" },
      ),
    );

    expect(failure.code).toMatch(/^[A-Z0-9_]+$/);
    expect(failure.code.length).toBe(MAX_FAILURE_CODE_LENGTH);
  });
});

describe("Madrid ERP year", () => {
  it("changes EJE at Madrid midnight, not at UTC midnight", () => {
    expect(madridEjeAt(new Date("2026-12-31T22:59:59.999Z"))).toBe(26);
    // Madrid is UTC+1 on New Year's Eve, so this instant is 2027-01-01 00:00.
    expect(madridEjeAt(new Date("2026-12-31T23:00:00.000Z"))).toBe(27);
  });
});

describe("runOrders", () => {
  it("fails before claiming when BRIDGE_EJE is not Madrid's current year", async () => {
    const h = harness({
      orders: [order(1)],
      cfg: { eje: 25 },
      now: () => new Date("2026-08-17T10:00:00.000Z"),
    });

    await expect(runOrders(h.deps)).rejects.toMatchObject({
      name: "EjeYearMismatchError",
      code: "EJE_YEAR_MISMATCH",
      configuredEje: 25,
      madridEje: 26,
    } satisfies Partial<EjeYearMismatchError>);
    expect(h.claims).toEqual([]);
    expect(h.connects).toBe(0);
  });

  it("claims only the configured UUID with limit one during a historical override", async () => {
    const h = harness({
      orders: [order(1), order(2, { id: HISTORICAL_ORDER_ID })],
      cfg: {
        eje: 25,
        allowHistoricalEje: true,
        historicalOrderId: HISTORICAL_ORDER_ID,
      },
      now: () => new Date("2026-08-17T10:00:00.000Z"),
    });

    await expect(runOrders(h.deps)).resolves.toMatchObject({ ok: true });
    expect(h.claims).toEqual([
      {
        token: TOKEN,
        limit: 1,
        lease: 300,
        orderId: HISTORICAL_ORDER_ID,
      },
    ]);
    expect(h.injects).toEqual([2]);
    expect(h.lines.find((line) => line.level === "WARN")?.fields).toMatchObject({
      code: "HISTORICAL_ORDER_OVERRIDE",
      orderId: HISTORICAL_ORDER_ID,
      configuredEje: 25,
      madridEje: 26,
    });
  });

  it("still warns and scopes an override when configured EJE matches Madrid", async () => {
    const h = harness({
      orders: [],
      cfg: {
        allowHistoricalEje: true,
        historicalOrderId: HISTORICAL_ORDER_ID,
      },
    });

    await runOrders(h.deps);
    expect(h.claims[0]).toMatchObject({ limit: 1, orderId: HISTORICAL_ORDER_ID });
    expect(h.lines.find((line) => line.level === "WARN")?.fields).toMatchObject({
      code: "HISTORICAL_ORDER_OVERRIDE",
      configuredEje: 26,
      madridEje: 26,
    });
  });

  it("rejects hand-built historical config inconsistencies before claiming", async () => {
    for (const override of [
      { allowHistoricalEje: true, historicalOrderId: null },
      { allowHistoricalEje: false, historicalOrderId: HISTORICAL_ORDER_ID },
    ] satisfies Partial<BridgeConfig>[]) {
      const h = harness({ orders: [order(1)], cfg: override });
      await expect(runOrders(h.deps)).rejects.toMatchObject({
        code: "BAD_HISTORICAL_ORDER_CONFIG",
      });
      expect(h.claims).toEqual([]);
      expect(h.connects).toBe(0);
    }
  });

  it("fails closed if the claim RPC returns an order outside the target scope", async () => {
    const h = harness({
      orders: [],
      cfg: {
        allowHistoricalEje: true,
        historicalOrderId: HISTORICAL_ORDER_ID,
      },
      claim: () => Promise.resolve([order(1)]),
    });

    await expect(runOrders(h.deps)).rejects.toMatchObject({
      code: "HISTORICAL_CLAIM_SCOPE_VIOLATION",
    });
    expect(h.connects).toBe(0);
    expect(h.injects).toEqual([]);
  });

  it("claims once with the run token and the configured limit and lease", async () => {
    const h = harness({ orders: [] });
    await runOrders(h.deps);
    expect(h.claims).toEqual([
      { token: TOKEN, limit: 20, lease: 300, orderId: null },
    ]);
  });

  it("does not open a SQL connection when there is nothing to inject", async () => {
    // This job runs every minute; an idle run must not touch the ERP.
    const h = harness({
      orders: [],
      countOrders: (filters) => {
        if (filters.status === "eq.bridge_failed") return Promise.resolve(2);
        if (filters.status === "eq.confirmed") return Promise.resolve(3);
        return Promise.resolve(1);
      },
    });
    const result = await runOrders(h.deps);

    expect(h.connects).toBe(0);
    expect(h.backlogQueries).toEqual([
      { status: "eq.bridge_failed" },
      { status: "eq.confirmed", bridge_attempt_count: "gt.0" },
      { status: "eq.processing" },
    ]);
    expect(result).toEqual({
      ok: true,
      counts: {
        claimed: 0,
        injected: 0,
        recovered: 0,
        failed: 0,
        requeued: 0,
        terminal: 0,
        markFailed: 0,
        failureMarkFailed: 0,
        manualRequired: 2,
        retryPending: 3,
        processingPending: 1,
        backlogCountError: 0,
        lotMissing: 0,
        lotExpired: 0,
        lotBlocked: 0,
      },
    });
  });

  it("fails backlog measurement closed without failing the completed run", async () => {
    const h = harness({
      orders: [],
      countOrders: (filters) => {
        if (filters.status === "eq.bridge_failed") {
          return Promise.reject(new Error("gateway unavailable"));
        }
        if (filters.status === "eq.confirmed") return Promise.resolve(null);
        return Promise.resolve(4);
      },
    });

    await expect(runOrders(h.deps)).resolves.toEqual({
      ok: true,
      counts: {
        claimed: 0,
        injected: 0,
        recovered: 0,
        failed: 0,
        requeued: 0,
        terminal: 0,
        markFailed: 0,
        failureMarkFailed: 0,
        manualRequired: null,
        retryPending: null,
        processingPending: 4,
        backlogCountError: 2,
        lotMissing: 0,
        lotExpired: 0,
        lotBlocked: 0,
      },
    });
    expect(h.backlogQueries).toHaveLength(3);
    expect(
      h.lines.filter((line) => line.fields.stage === "order_backlog_count"),
    ).toHaveLength(2);
  });

  it("injects sequentially and marks each order with the SAME claim token", async () => {
    const h = harness({ orders: [order(1), order(2), order(3)] });
    const result = await runOrders(h.deps);

    expect(h.injects).toEqual([1, 2, 3]);
    expect(h.marks).toEqual([
      { orderId: "order-1", token: TOKEN, can: "B", eje: 26, numped: 501 },
      { orderId: "order-2", token: TOKEN, can: "B", eje: 26, numped: 502 },
      { orderId: "order-3", token: TOKEN, can: "B", eje: 26, numped: 503 },
    ]);
    expect(result.counts).toMatchObject({ claimed: 3, injected: 3, failed: 0 });
    const firstCount = h.events.findIndex((event) => event.startsWith("count:"));
    const lastMark = h.events
      .map((event) => event.startsWith("mark_injected:"))
      .lastIndexOf(true);
    expect(firstCount).toBeGreaterThan(lastMark);
    expect(h.events.slice(firstCount)).toEqual([
      "count:eq.bridge_failed",
      "count:eq.confirmed",
      "count:eq.processing",
    ]);
    expect(h.connects).toBe(1);
    expect(h.closes).toBe(1);
  });

  it("marks a dedup recovery with the RECOVERED numped and counts it apart", async () => {
    // The crash-after-inject-before-mark window: the pedido is already there.
    const h = harness({
      orders: [order(7)],
      inject: () =>
        Promise.resolve(
          injected(999, { can: "A", eje: 25, recovered: true, lineCount: 0 }),
        ),
    });
    const result = await runOrders(h.deps);

    expect(h.marks).toEqual([
      { orderId: "order-7", token: TOKEN, can: "A", eje: 25, numped: 999 },
    ]);
    expect(result.counts).toMatchObject({ injected: 0, recovered: 1, failed: 0 });
    // lineCount is 0 on recovery by contract, and the log says so.
    expect(h.lines.some((l) => l.fields.lineCount === 0)).toBe(true);
  });

  it("records a permanent inject failure, then CONTINUES", async () => {
    const h = harness({
      orders: [order(1), order(2), order(3)],
      inject: (claimed) =>
        claimed.order_number === 2
          ? Promise.reject(
              new InjectError(
                "ERP_ARTICLE_NOT_FOUND",
                "codart 9-999 is not in articulo",
                {
                  orderId: "order-2",
                  orderNumber: 2,
                  ref: "PORTAL-2",
                },
                { retryable: false },
              ),
            )
          : Promise.resolve(injected(500 + claimed.order_number)),
    });
    const result = await runOrders(h.deps);

    expect(h.injects).toEqual([1, 2, 3]);
    expect(h.marks.map((m) => m.orderId)).toEqual(["order-1", "order-3"]);
    expect(h.failureMarks).toEqual([
      {
        orderId: "order-2",
        token: TOKEN,
        code: "ERP_ARTICLE_NOT_FOUND",
        message: expect.stringContaining("codart 9-999"),
        retryable: false,
      },
    ]);
    expect(result.counts).toMatchObject({
      claimed: 3,
      injected: 2,
      failed: 1,
      requeued: 0,
      terminal: 1,
      failureMarkFailed: 0,
    });

    const failure = h.lines.find((l) => l.fields.stage === "inject");
    expect(failure?.fields).toMatchObject({ orderId: "order-2", orderNumber: 2 });
  });

  it.each([ERP_COMMIT_OUTCOME_UNKNOWN, ERP_ROLLBACK_FAILED])(
    "aborts the SQL batch on %s, requeues every unattempted claim and returns red",
    async (failureCode) => {
      const h = harness({
        orders: [order(1), order(2), order(3), order(4)],
        inject: (claimed) =>
          claimed.order_number === 2
            ? Promise.reject(
                new InjectError(
                  failureCode,
                  "ERP transaction outcome is unsafe",
                  {
                    orderId: claimed.id,
                    orderNumber: claimed.order_number,
                    ref: `PORTAL-${claimed.order_number}`,
                  },
                  { retryable: true, abortBatch: true },
                ),
              )
            : Promise.resolve(injected(500 + claimed.order_number)),
      });

      const result = await runOrders(h.deps);

      // Order 1 completed, order 2 made the connection unsafe, and neither 3
      // nor 4 was passed the same SQL pool afterwards.
      expect(h.injects).toEqual([1, 2]);
      expect(h.failureMarks.map(({ orderId, code, retryable }) => ({
        orderId,
        code,
        retryable,
      }))).toEqual([
        { orderId: "order-2", code: failureCode, retryable: true },
        {
          orderId: "order-3",
          code: BATCH_ABORTED_UNSAFE_ERP_CONNECTION,
          retryable: true,
        },
        {
          orderId: "order-4",
          code: BATCH_ABORTED_UNSAFE_ERP_CONNECTION,
          retryable: true,
        },
      ]);
      expect(result).toMatchObject({
        ok: false,
        counts: {
          code: BATCH_ABORTED_UNSAFE_ERP_CONNECTION,
          claimed: 4,
          injected: 1,
          recovered: 0,
          failed: 3,
          requeued: 3,
          terminal: 0,
          failureMarkFailed: 0,
        },
      });
      expect(
        Number(result.counts.injected) +
          Number(result.counts.recovered) +
          Number(result.counts.failed),
      ).toBe(result.counts.claimed);
      expect(h.closes).toBe(1);
      expect(h.events.indexOf("pool_close")).toBeLessThan(
        h.events.findIndex((event) => event.startsWith("count:")),
      );
    },
  );

  it("counts a failed backlog requeue without resuming SQL injection", async () => {
    const h = harness({
      orders: [order(1), order(2), order(3)],
      inject: (claimed) =>
        Promise.reject(
          new InjectError(
            ERP_ROLLBACK_FAILED,
            "rollback failed",
            {
              orderId: claimed.id,
              orderNumber: claimed.order_number,
              ref: `PORTAL-${claimed.order_number}`,
            },
            { retryable: true, abortBatch: true },
          ),
        ),
      markFailure: (orderId) =>
        orderId === "order-3"
          ? Promise.reject(new Error("Supabase unavailable"))
          : Promise.resolve({ marked: true, outcome: "requeued", attemptCount: 1 }),
    });

    const result = await runOrders(h.deps);

    expect(h.injects).toEqual([1]);
    expect(h.failureMarks.map((mark) => mark.orderId)).toEqual([
      "order-1",
      "order-2",
      "order-3",
    ]);
    expect(result).toMatchObject({
      ok: false,
      counts: {
        code: BATCH_ABORTED_UNSAFE_ERP_CONNECTION,
        claimed: 3,
        failed: 3,
        requeued: 2,
        failureMarkFailed: 1,
      },
    });
    expect(h.closes).toBe(1);
  });

  it("stays ok and schedules retries when every order has a transient failure", async () => {
    const h = harness({
      orders: [order(1), order(2)],
      inject: () => Promise.reject(new Error("ERP unreachable mid-run")),
    });
    const result = await runOrders(h.deps);

    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({
      claimed: 2,
      failed: 2,
      injected: 0,
      requeued: 2,
      terminal: 0,
    });
    expect(h.failureMarks.every((mark) => mark.retryable)).toBe(true);
  });

  it("marks an all-excluded order terminal on its first failure", async () => {
    const h = harness({
      orders: [order(4)],
      inject: () =>
        Promise.reject(
          new AllLinesExcludedError({
            orderId: "order-4",
            orderNumber: 4,
            ref: "PORTAL-4",
          }),
        ),
    });

    const result = await runOrders(h.deps);
    expect(h.failureMarks[0]).toMatchObject({
      code: "ALL_LINES_EXCLUDED",
      retryable: false,
    });
    expect(result.counts).toMatchObject({ failed: 1, terminal: 1, requeued: 0 });
  });

  it("trusts the DB ceiling when a retryable fifth failure becomes terminal", async () => {
    const h = harness({
      orders: [order(5)],
      inject: () => Promise.reject(new Error("timeout")),
      markFailure: () =>
        Promise.resolve({ marked: true, outcome: "terminal", attemptCount: 5 }),
    });

    const result = await runOrders(h.deps);
    expect(h.failureMarks[0].retryable).toBe(true);
    expect(result.counts).toMatchObject({ failed: 1, requeued: 0, terminal: 1 });
  });

  it("alerts when the failure RPC rejects a stale claim", async () => {
    const h = harness({
      orders: [order(6)],
      inject: () => Promise.reject(new Error("timeout")),
      markFailure: () =>
        Promise.resolve({ marked: false, outcome: "stale_claim", attemptCount: null }),
    });

    const result = await runOrders(h.deps);
    expect(result.counts).toMatchObject({
      failed: 1,
      requeued: 0,
      terminal: 0,
      failureMarkFailed: 1,
    });
    expect(h.lines.some((line) => line.message.includes("rejected the claim"))).toBe(true);
  });

  it("alerts and continues when the failure RPC itself throws", async () => {
    const h = harness({
      orders: [order(7), order(8)],
      inject: (claimed) =>
        claimed.order_number === 7
          ? Promise.reject(new Error("deadlock"))
          : Promise.resolve(injected(508)),
      markFailure: () => Promise.reject(new Error("Supabase unavailable")),
    });

    const result = await runOrders(h.deps);
    expect(h.injects).toEqual([7, 8]);
    expect(result.counts).toMatchObject({
      claimed: 2,
      injected: 1,
      failed: 1,
      failureMarkFailed: 1,
    });
    expect(h.lines.some((line) => line.fields.stage === "mark_order_failed")).toBe(true);
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
    expect(
      Number(counts.requeued) +
        Number(counts.terminal) +
        Number(counts.failureMarkFailed),
    ).toBe(counts.failed);
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

  it("says nothing about lots on a clean order", async () => {
    // `formatFields` drops nulls, so the INFO line of an order whose every
    // line got an in-date covering lot is byte-identical to the one this job
    // printed before the ladder existed — and no WARN is raised at all.
    const h = harness({ orders: [order(1)] });
    const result = await runOrders(h.deps);

    const line = h.lines.find((l) => l.message === "injected");
    expect(line?.fields.lotMissing).toBeNull();
    expect(line?.fields.lotExpired).toBeNull();
    expect(line?.fields.lotBlocked).toBeNull();
    expect(line?.fields.lotShort).toBeNull();
    expect(h.lines.some((l) => l.level === "WARN")).toBe(false);
    expect(result.counts).toMatchObject({
      lotMissing: 0,
      lotExpired: 0,
      lotBlocked: 0,
    });
  });

  it("counts and names the lines a human has to look at, one WARN per kind", async () => {
    const h = harness({
      orders: [order(1)],
      inject: () =>
        Promise.resolve(
          injected(501, {
            lotFlags: [
              // No stock in any lot at any date: this line WILL be refused at
              // conversion, and the owner learns it now instead of at 6am.
              {
                codart: "100-003",
                codlot: "",
                tier: "none",
                outcome: "no_stock",
                feccad: null,
                dispo: null,
                diasCad: null,
                qtyBase: 24,
              },
              {
                codart: "100-005",
                codlot: "",
                tier: "none",
                outcome: "no_stock",
                feccad: null,
                dispo: null,
                diasCad: null,
                qtyBase: 6,
              },
              // The expired rescue, refused by the default policy.
              {
                codart: "100-002A",
                codlot: "",
                tier: "expired_covering",
                outcome: "expired_refused",
                feccad: null,
                dispo: 18,
                diasCad: 144,
                qtyBase: 24,
              },
              // In date but short: logged, never tallied — at job level it is a
              // number nobody can act on.
              {
                codart: "1-006",
                codlot: "4360401703",
                tier: "fresh_partial",
                outcome: "lot_used",
                feccad: "2027-08-10",
                dispo: 2,
                diasCad: null,
                qtyBase: 24,
              },
            ],
          }),
        ),
    });
    const result = await runOrders(h.deps);

    expect(result.counts).toMatchObject({
      lotMissing: 2,
      lotExpired: 0,
      lotBlocked: 1,
    });
    const line = h.lines.find((l) => l.message === "injected");
    expect(line?.fields).toMatchObject({
      lotMissing: 2,
      lotBlocked: 1,
      lotShort: 1,
    });
    expect(line?.fields.lotExpired).toBeNull();

    const warns = h.lines.filter((l) => l.level === "WARN");
    expect(warns.map((l) => l.fields.code)).toEqual([
      "LOT_NO_STOCK",
      "LOT_EXPIRED_BLOCKED",
    ]);
    expect(warns[0].fields.codarts).toBe("100-003,100-005");
    expect(warns[0].fields.numped).toBe(501);
    expect(warns[1].fields.lots).toBe("100-002A:expired_refused:144d:18");
  });

  it("warns loudly, and separately, when an expired lot was actually written", async () => {
    const h = harness({
      orders: [order(1)],
      inject: () =>
        Promise.resolve(
          injected(501, {
            lotFlags: [
              {
                codart: "100-002A",
                codlot: "037",
                tier: "expired_covering",
                outcome: "expired_used",
                feccad: "2026-03-30",
                dispo: 18,
                diasCad: 144,
                qtyBase: 24,
              },
            ],
          }),
        ),
    });
    const result = await runOrders(h.deps);

    expect(result.counts).toMatchObject({ lotExpired: 1, lotBlocked: 0 });
    const warn = h.lines.find((l) => l.level === "WARN");
    expect(warn?.fields.code).toBe("LOT_EXPIRED_WRITTEN");
    // The lot, its real date and its staleness: everything the person checking
    // the pedido in Wingest needs before pressing Albarán.
    expect(warn?.fields.lots).toBe("100-002A:037:2026-03-30:144d");
  });

  it("sums the lot counters across orders and reports none for a recovery", async () => {
    const flag = {
      codart: "100-003",
      codlot: "",
      tier: "none" as const,
      outcome: "no_stock" as const,
      feccad: null,
      dispo: null,
      diasCad: null,
      qtyBase: 24,
    };
    const h = harness({
      orders: [order(1), order(2), order(3)],
      inject: (claimed) =>
        Promise.resolve(
          claimed.order_number === 3
            ? // Recovery wrote nothing and picked no lot, by the same contract
              // `lineCount` follows.
              injected(503, { recovered: true, lineCount: 0 })
            : injected(500 + claimed.order_number, { lotFlags: [flag] }),
        ),
    });
    const result = await runOrders(h.deps);

    expect(result.counts).toMatchObject({
      claimed: 3,
      injected: 2,
      recovered: 1,
      lotMissing: 2,
    });
    expect(
      h.lines.filter((l) => l.fields.code === "LOT_NO_STOCK"),
    ).toHaveLength(2);
  });
});
