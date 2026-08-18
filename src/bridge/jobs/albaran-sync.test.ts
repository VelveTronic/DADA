import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../config";
import type { SqlParent } from "../injector";
import type { LogFields, Logger } from "../log";
import type { InjectedOrderRef } from "../supabase";
import {
  ALBARAN_CHUNK_SIZE,
  albaranCounts,
  buildAlbaranParams,
  buildAlbaranQuery,
  buildHistoricalPedidoParams,
  buildHistoricalPedidoQuery,
  chunk,
  emptyAlbaranTally,
  indexByErpIdentity,
  readAlbaranRow,
  readHistoricalPedidoRow,
  runAlbaranSync,
  type AlbaranDeps,
} from "./albaran-sync";

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
  allowHistoricalEje: false,
  historicalOrderId: null,
  alm: "00001",
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
};

function injectedRef(
  id: string,
  numped: number | null,
  overrides: Partial<InjectedOrderRef> = {},
): InjectedOrderRef {
  return {
    id,
    orderNumber: numped ?? 1,
    erpCan: "B",
    erpEje: 26,
    numped,
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

interface RecordedQuery {
  text: string;
  params: Record<string, unknown>;
}

interface Harness {
  deps: AlbaranDeps;
  lines: Line[];
  queries: RecordedQuery[];
  marks: { orderId: string; numalb: number }[];
  identityMarks: { orderId: string; can: string; eje: number; numalb: number }[];
  backfills: { orderId: string; can: string; eje: number; numped: number }[];
  connects: () => number;
  closes: () => number;
}

function harness(options: {
  injected: InjectedOrderRef[];
  rows?: Record<string, unknown>[][];
  mark?: (
    orderId: string,
    can: string,
    eje: number,
    numalb: number,
  ) => Promise<boolean>;
  backfill?: (
    orderId: string,
    can: string,
    eje: number,
    numped: number,
  ) => Promise<boolean>;
}): Harness {
  const { log, lines } = recorder();
  const queries: RecordedQuery[] = [];
  const marks: { orderId: string; numalb: number }[] = [];
  const identityMarks: {
    orderId: string;
    can: string;
    eje: number;
    numalb: number;
  }[] = [];
  const backfills: {
    orderId: string;
    can: string;
    eje: number;
    numped: number;
  }[] = [];
  const state = { connects: 0, closes: 0 };
  const queue = [...(options.rows ?? [])];

  const pool = {
    request() {
      const params: Record<string, unknown> = {};
      const request = {
        input(name: string, _type: unknown, value: unknown) {
          params[name] = value;
          return request;
        },
        query(text: string) {
          queries.push({ text, params });
          const recordset = (queue.shift() ?? []).map((row) => ({
            CAN: row.CAN === undefined ? "B" : row.CAN,
            EJEALB: row.EJEALB === undefined ? 26 : row.EJEALB,
            ...row,
          }));
          return Promise.resolve({ recordset, recordsets: [recordset] });
        },
      };
      return request;
    },
    close() {
      state.closes++;
      return Promise.resolve();
    },
  };

  const deps: AlbaranDeps = {
    cfg,
    log,
    api: {
      listInjected: () => Promise.resolve(options.injected),
      markAlbaran: (orderId, can, eje, numalb) => {
        marks.push({ orderId, numalb });
        identityMarks.push({ orderId, can, eje, numalb });
        return options.mark
          ? options.mark(orderId, can, eje, numalb)
          : Promise.resolve(true);
      },
      backfillOrderIdentity: (orderId, can, eje, numped) => {
        backfills.push({ orderId, can, eje, numped });
        return options.backfill
          ? options.backfill(orderId, can, eje, numped)
          : Promise.resolve(true);
      },
    },
    connect: () => {
      state.connects++;
      return Promise.resolve(pool as unknown as SqlParent & { close(): Promise<unknown> });
    },
  };

  return {
    deps,
    lines,
    queries,
    marks,
    identityMarks,
    backfills,
    connects: () => state.connects,
    closes: () => state.closes,
  };
}

describe("chunk", () => {
  it("splits into full batches plus a remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one batch when everything fits", () => {
    expect(chunk([1, 2], 200)).toEqual([[1, 2]]);
  });

  it("returns nothing for an empty input", () => {
    expect(chunk([], 200)).toEqual([]);
  });

  it("splits exactly at the boundary", () => {
    const items = Array.from({ length: 400 }, (_, i) => i);
    const batches = chunk(items, ALBARAN_CHUNK_SIZE);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(200);
    expect(batches[1][0]).toBe(200);
  });

  it("rejects a size that would loop forever", () => {
    expect(() => chunk([1], 0)).toThrow(/positive integer/);
    expect(() => chunk([1], -1)).toThrow();
  });
});

describe("buildAlbaranQuery", () => {
  it("parameterises every NUMPED", () => {
    expect(buildAlbaranQuery(3)).toBe(
      "SELECT CAN, EJEALB, NUMPED, NUMALB FROM albfacca " +
        "WHERE CAN=@can AND EJEALB>=@eje AND EJEALB<=@nextEje " +
        "AND NUMPED IN (@p0, @p1, @p2) " +
        "ORDER BY NUMPED, EJEALB, NUMALB",
    );
  });

  it("keeps Albarán year independent and permits the following fiscal year", () => {
    expect(buildAlbaranQuery(1)).toBe(
      "SELECT CAN, EJEALB, NUMPED, NUMALB FROM albfacca " +
        "WHERE CAN=@can AND EJEALB>=@eje AND EJEALB<=@nextEje AND NUMPED IN (@p0) " +
        "ORDER BY NUMPED, EJEALB, NUMALB",
    );
  });

  it("orders by NUMALB so the lowest albarán of a split delivery comes first", () => {
    expect(buildAlbaranQuery(1)).toContain("ORDER BY NUMPED, EJEALB, NUMALB");
  });

  it("puts no literal value in the statement, whatever the batch size", () => {
    const text = buildAlbaranQuery(ALBARAN_CHUNK_SIZE);
    expect(text.match(/@p\d+/g)).toHaveLength(ALBARAN_CHUNK_SIZE);
    // Only parameters, table and column names — no digits outside @pN.
    expect(text.replace(/@p\d+/g, "")).not.toMatch(/\d/);
  });

  it("refuses an empty IN list, which is a syntax error in T-SQL", () => {
    expect(() => buildAlbaranQuery(0)).toThrow(/at least one/);
  });
});

describe("buildAlbaranParams", () => {
  it("binds the persisted canal/year and one parameter per NUMPED", () => {
    const params = buildAlbaranParams([501, 502], { erpCan: "A", erpEje: 25 });
    expect(Object.keys(params)).toEqual(["can", "eje", "nextEje", "p0", "p1"]);
    expect(params.can.value).toBe("A");
    expect(params.eje.value).toBe(25);
    expect(params.nextEje.value).toBe(26);
    expect(params.p0.value).toBe(501);
    expect(params.p1.value).toBe(502);
  });
});

describe("historical Pedido identity lookup", () => {
  it("matches the portal reference and NUMPED in both live and history tables", () => {
    expect(buildHistoricalPedidoQuery()).toBe(
      "SELECT TOP 1 CAN, EJE, NUMPED FROM (" +
        "SELECT CAN, EJE, NUMPED, RTRIM(NUMPEDCLI) AS NUMPEDCLI FROM pedclica " +
        "UNION ALL " +
        "SELECT CAN, EJE, NUMPED, RTRIM(NUMPEDCLI) AS NUMPEDCLI FROM pedclicah" +
        ") z WHERE z.NUMPED=@numped AND z.NUMPEDCLI=@ref " +
        "ORDER BY z.EJE DESC, z.NUMPED DESC",
    );
    expect(buildHistoricalPedidoParams({ orderNumber: 4242, numped: 501 })).toEqual({
      numped: expect.objectContaining({ value: 501 }),
      ref: expect.objectContaining({ value: "PORTAL-4242" }),
    });
  });

  it("normalizes the ERP row without substituting configured CAN/EJE", () => {
    expect(
      readHistoricalPedidoRow({ CAN: " a ", EJE: "25", NUMPED: "501" }),
    ).toEqual({ can: "A", eje: 25, numped: 501 });
  });
});

describe("indexByErpIdentity", () => {
  it("maps each NUMPED inside its saved CAN/EJE scope", () => {
    const { groups, withoutIdentity } = indexByErpIdentity([
      injectedRef("a", 501),
      injectedRef("b", 502),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ erpCan: "B", erpEje: 26 });
    expect([...groups[0].byNumped.entries()]).toEqual([
      [501, ["a"]],
      [502, ["b"]],
    ]);
    expect(withoutIdentity).toEqual([]);
  });

  it("keeps every order when two share the complete ERP identity", () => {
    const { groups } = indexByErpIdentity([
      injectedRef("a", 501),
      injectedRef("b", 501),
    ]);
    expect(groups[0].byNumped.get(501)).toEqual(["a", "b"]);
  });

  it("keeps the same NUMPED in different fiscal years separate", () => {
    const { groups } = indexByErpIdentity([
      injectedRef("old", 501, { erpEje: 26 }),
      injectedRef("new", 501, { erpEje: 27 }),
    ]);
    expect(groups.map((group) => [group.erpEje, [...group.byNumped.keys()]])).toEqual([
      [26, [501]],
      [27, [501]],
    ]);
  });

  it("sets aside an order missing any identity component", () => {
    const { groups, withoutIdentity } = indexByErpIdentity([
      injectedRef("a", null),
      injectedRef("b", 501, { erpCan: null }),
      injectedRef("c", 502, { erpEje: null }),
      injectedRef("ok", 503),
    ]);
    expect(withoutIdentity).toEqual(["a", "b", "c"]);
    expect(groups[0].byNumped.size).toBe(1);
  });
});

describe("readAlbaranRow", () => {
  it("reads plain numbers", () => {
    expect(readAlbaranRow({ CAN: "B", EJEALB: 27, NUMPED: 501, NUMALB: 88 })).toEqual({
      can: "B",
      eje: 27,
      numped: 501,
      numalb: 88,
    });
  });

  it("reads the strings tedious hands back for wide integer columns", () => {
    expect(readAlbaranRow({ CAN: "A", EJEALB: "27", NUMPED: "501", NUMALB: "88" })).toEqual({
      can: "A",
      eje: 27,
      numped: 501,
      numalb: 88,
    });
  });

  it("reads a missing albarán number as null", () => {
    expect(readAlbaranRow({ NUMPED: 501, NUMALB: null }).numalb).toBeNull();
  });
});

describe("albaranCounts", () => {
  it("emits the identity, match, mark and failure summary fields", () => {
    expect(Object.keys(albaranCounts(emptyAlbaranTally()))).toEqual([
      "injected",
      "matched",
      "marked",
      "failed",
    ]);
  });
});

describe("runAlbaranSync", () => {
  it("does not open a SQL connection when nothing is awaiting an albarán", async () => {
    const h = harness({ injected: [] });
    const result = await runAlbaranSync(h.deps);

    expect(h.connects()).toBe(0);
    expect(result).toEqual({
      ok: true,
      counts: { injected: 0, matched: 0, marked: 0, failed: 0 },
    });
  });

  it("asks once for the whole batch and marks every match", async () => {
    const h = harness({
      injected: [
        injectedRef("a", 501),
        injectedRef("b", 502),
      ],
      rows: [[{ NUMPED: 502, NUMALB: 88 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].params).toMatchObject({ can: "B", eje: 26, p0: 501, p1: 502 });
    expect(h.marks).toEqual([{ orderId: "b", numalb: 88 }]);
    expect(result.counts).toEqual({ injected: 2, matched: 1, marked: 1, failed: 0 });
    expect(h.closes()).toBe(1);
  });

  it("matches a December Pedido to a next-year Albarán and forwards that identity", async () => {
    const h = harness({
      injected: [injectedRef("december", 501, { erpEje: 26 })],
      rows: [[{ CAN: "B", EJEALB: 27, NUMPED: 501, NUMALB: 900 }]],
    });

    await runAlbaranSync(h.deps);

    expect(h.identityMarks).toEqual([
      { orderId: "december", can: "B", eje: 27, numalb: 900 },
    ]);
  });

  it("resolves and persists a missing historical Pedido identity before Albarán lookup", async () => {
    const h = harness({
      injected: [
        injectedRef("historical", 501, {
          orderNumber: 4242,
          erpCan: null,
          erpEje: null,
        }),
      ],
      rows: [
        [{ CAN: "A", EJE: 25, NUMPED: 501 }],
        [{ CAN: "A", EJEALB: 26, NUMPED: 501, NUMALB: 901 }],
      ],
    });

    const result = await runAlbaranSync(h.deps);

    expect(h.backfills).toEqual([
      { orderId: "historical", can: "A", eje: 25, numped: 501 },
    ]);
    expect(h.identityMarks).toEqual([
      { orderId: "historical", can: "A", eje: 26, numalb: 901 },
    ]);
    expect(result).toEqual({
      ok: true,
      counts: { injected: 1, matched: 1, marked: 1, failed: 0 },
    });
  });

  it("queries and matches the same NUMPED independently in each persisted ERP scope", async () => {
    const h = harness({
      injected: [
        injectedRef("old", 501, { erpCan: "A", erpEje: 25 }),
        injectedRef("current", 501, { erpCan: "B", erpEje: 26 }),
      ],
      rows: [
        [{ NUMPED: 501, NUMALB: 70 }],
        [{ NUMPED: 501, NUMALB: 88 }],
      ],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.queries).toHaveLength(2);
    expect(h.queries.map(({ params }) => params)).toEqual([
      expect.objectContaining({ can: "A", eje: 25, p0: 501 }),
      expect.objectContaining({ can: "B", eje: 26, p0: 501 }),
    ]);
    expect(h.marks).toEqual([
      { orderId: "old", numalb: 70 },
      { orderId: "current", numalb: 88 },
    ]);
    expect(result.counts).toEqual({ injected: 2, matched: 2, marked: 2, failed: 0 });
  });

  it("chunks a backlog past the batch size into several queries", async () => {
    const injected = Array.from({ length: ALBARAN_CHUNK_SIZE + 5 }, (_, i) =>
      injectedRef(`o${i}`, 1000 + i),
    );
    const h = harness({ injected, rows: [[], []] });
    const result = await runAlbaranSync(h.deps);

    expect(h.queries).toHaveLength(2);
    expect(Object.keys(h.queries[0].params)).toHaveLength(ALBARAN_CHUNK_SIZE + 3);
    expect(Object.keys(h.queries[1].params)).toHaveLength(5 + 3);
    expect(result.counts.injected).toBe(ALBARAN_CHUNK_SIZE + 5);
  });

  it("counts a FALSE mark as matched-but-not-marked and logs it as an error", async () => {
    const h = harness({
      injected: [injectedRef("a", 501)],
      rows: [[{ NUMPED: 501, NUMALB: 88 }]],
      mark: () => Promise.resolve(false),
    });
    const result = await runAlbaranSync(h.deps);

    expect(result.counts).toEqual({ injected: 1, matched: 1, marked: 0, failed: 0 });
    const alert = h.lines.find((l) => l.message.includes("mark_albaran"));
    expect(alert?.level).toBe("ERROR");
  });

  it("keeps going when one mark throws", async () => {
    const h = harness({
      injected: [
        injectedRef("a", 501),
        injectedRef("b", 502),
      ],
      rows: [
        [
          { NUMPED: 501, NUMALB: 88 },
          { NUMPED: 502, NUMALB: 89 },
        ],
      ],
      mark: (orderId) =>
        orderId === "a"
          ? Promise.reject(new Error("socket hang up"))
          : Promise.resolve(true),
    });
    const result = await runAlbaranSync(h.deps);

    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ injected: 2, matched: 2, marked: 1, failed: 0 });
  });

  it("ignores an albfacca row whose NUMALB is not usable", async () => {
    const h = harness({
      injected: [injectedRef("a", 501)],
      rows: [[{ NUMPED: 501, NUMALB: 0 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([]);
    expect(result.counts).toEqual({ injected: 1, matched: 0, marked: 0, failed: 0 });
    expect(h.lines.some((l) => l.level === "WARN")).toBe(true);
  });

  it("marks a split delivery ONCE, on its first albarán", async () => {
    // One pedido, delivered in two goes: albfacca holds a row per delivery, and
    // ORDER BY NUMALB puts the lowest first. The portal shows one number.
    const h = harness({
      injected: [injectedRef("a", 501)],
      rows: [
        [
          { NUMPED: 501, NUMALB: 88 },
          { NUMPED: 501, NUMALB: 91 },
        ],
      ],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([{ orderId: "a", numalb: 88 }]);
    expect(result.counts).toEqual({ injected: 1, matched: 1, marked: 1, failed: 0 });
    expect(h.lines.filter((l) => l.level === "ERROR")).toEqual([]);
  });

  it("does not re-mark a pedido whose second albarán lands in a later chunk", async () => {
    const injected = Array.from({ length: ALBARAN_CHUNK_SIZE + 1 }, (_, i) =>
      injectedRef(`o${i}`, 1000 + i),
    );
    const h = harness({
      injected,
      rows: [[{ NUMPED: 1000, NUMALB: 88 }], [{ NUMPED: 1000, NUMALB: 91 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([{ orderId: "o0", numalb: 88 }]);
    expect(result.counts.matched).toBe(1);
    expect(result.counts.marked).toBe(1);
  });

  it("keeps matched at or below the number of pedidos it asked about", async () => {
    const h = harness({
      injected: [
        injectedRef("a", 501),
        injectedRef("b", 502),
      ],
      rows: [
        [
          { NUMPED: 501, NUMALB: 88 },
          { NUMPED: 501, NUMALB: 89 },
          { NUMPED: 502, NUMALB: 90 },
          { NUMPED: 502, NUMALB: 92 },
        ],
      ],
    });
    const { counts } = await runAlbaranSync(h.deps);

    expect(Number(counts.matched)).toBeLessThanOrEqual(Number(counts.injected));
    expect(counts).toEqual({ injected: 2, matched: 2, marked: 2, failed: 0 });
  });

  it("ignores a NUMPED the portal is not waiting for", async () => {
    const h = harness({
      injected: [injectedRef("a", 501)],
      rows: [[{ NUMPED: 999, NUMALB: 88 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([]);
    expect(result.counts.matched).toBe(0);
  });

  it("reports injected orders that lack a complete ERP identity", async () => {
    const h = harness({
      injected: [
        injectedRef("a", null),
        injectedRef("b", 501, { erpCan: null }),
        injectedRef("c", 502, { erpEje: null }),
      ],
    });
    const result = await runAlbaranSync(h.deps);

    expect(result.counts.injected).toBe(0);
    expect(result.counts.failed).toBe(3);
    expect(result.ok).toBe(true);
    expect(h.connects()).toBe(1);
    const alert = h.lines.find((l) => l.fields.count === 3);
    expect(alert?.fields).toMatchObject({ count: 3, orderIds: "a,b,c" });
  });

  it("marks every order sharing a numped and warns about the collision", async () => {
    const h = harness({
      injected: [
        injectedRef("a", 501),
        injectedRef("b", 501),
      ],
      rows: [[{ NUMPED: 501, NUMALB: 88 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([
      { orderId: "a", numalb: 88 },
      { orderId: "b", numalb: 88 },
    ]);
    expect(result.counts).toEqual({ injected: 1, matched: 1, marked: 2, failed: 0 });
    expect(h.lines.some((l) => l.level === "WARN")).toBe(true);
  });
});
