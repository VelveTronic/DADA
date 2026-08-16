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
  chunk,
  emptyAlbaranTally,
  indexByNumped,
  readAlbaranRow,
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
  alm: "00001",
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
};

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
  connects: () => number;
  closes: () => number;
}

function harness(options: {
  injected: InjectedOrderRef[];
  rows?: Record<string, unknown>[][];
  mark?: (orderId: string, numalb: number) => Promise<boolean>;
}): Harness {
  const { log, lines } = recorder();
  const queries: RecordedQuery[] = [];
  const marks: { orderId: string; numalb: number }[] = [];
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
          const recordset = queue.shift() ?? [];
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
      markAlbaran: (orderId, numalb) => {
        marks.push({ orderId, numalb });
        return options.mark ? options.mark(orderId, numalb) : Promise.resolve(true);
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
      "SELECT NUMPED, NUMALB FROM albfacca " +
        "WHERE CAN=@can AND EJEALB=@eje AND NUMPED IN (@p0, @p1, @p2)",
    );
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
  it("binds the canal, the fiscal year and one parameter per NUMPED", () => {
    const params = buildAlbaranParams([501, 502], cfg);
    expect(Object.keys(params)).toEqual(["can", "eje", "p0", "p1"]);
    expect(params.can.value).toBe("B");
    expect(params.eje.value).toBe(26);
    expect(params.p0.value).toBe(501);
    expect(params.p1.value).toBe(502);
  });
});

describe("indexByNumped", () => {
  it("maps each numped to the orders waiting on it", () => {
    const { byNumped, withoutNumped } = indexByNumped([
      { id: "a", numped: 501 },
      { id: "b", numped: 502 },
    ]);
    expect([...byNumped.entries()]).toEqual([
      [501, ["a"]],
      [502, ["b"]],
    ]);
    expect(withoutNumped).toEqual([]);
  });

  it("keeps every order when two share a numped", () => {
    const { byNumped } = indexByNumped([
      { id: "a", numped: 501 },
      { id: "b", numped: 501 },
    ]);
    expect(byNumped.get(501)).toEqual(["a", "b"]);
  });

  it("sets aside injected orders with no numped instead of dropping them", () => {
    const { byNumped, withoutNumped } = indexByNumped([
      { id: "a", numped: null },
      { id: "b", numped: 501 },
    ]);
    expect(withoutNumped).toEqual(["a"]);
    expect(byNumped.size).toBe(1);
  });
});

describe("readAlbaranRow", () => {
  it("reads plain numbers", () => {
    expect(readAlbaranRow({ NUMPED: 501, NUMALB: 88 })).toEqual({
      numped: 501,
      numalb: 88,
    });
  });

  it("reads the strings tedious hands back for wide integer columns", () => {
    expect(readAlbaranRow({ NUMPED: "501", NUMALB: "88" })).toEqual({
      numped: 501,
      numalb: 88,
    });
  });

  it("reads a missing albarán number as null", () => {
    expect(readAlbaranRow({ NUMPED: 501, NUMALB: null }).numalb).toBeNull();
  });
});

describe("albaranCounts", () => {
  it("emits the three summary fields the plan names", () => {
    expect(Object.keys(albaranCounts(emptyAlbaranTally()))).toEqual([
      "injected",
      "matched",
      "marked",
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
      counts: { injected: 0, matched: 0, marked: 0 },
    });
  });

  it("asks once for the whole batch and marks every match", async () => {
    const h = harness({
      injected: [
        { id: "a", numped: 501 },
        { id: "b", numped: 502 },
      ],
      rows: [[{ NUMPED: 502, NUMALB: 88 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].params).toMatchObject({ can: "B", eje: 26, p0: 501, p1: 502 });
    expect(h.marks).toEqual([{ orderId: "b", numalb: 88 }]);
    expect(result.counts).toEqual({ injected: 2, matched: 1, marked: 1 });
    expect(h.closes()).toBe(1);
  });

  it("chunks a backlog past the batch size into several queries", async () => {
    const injected = Array.from({ length: ALBARAN_CHUNK_SIZE + 5 }, (_, i) => ({
      id: `o${i}`,
      numped: 1000 + i,
    }));
    const h = harness({ injected, rows: [[], []] });
    const result = await runAlbaranSync(h.deps);

    expect(h.queries).toHaveLength(2);
    expect(Object.keys(h.queries[0].params)).toHaveLength(ALBARAN_CHUNK_SIZE + 2);
    expect(Object.keys(h.queries[1].params)).toHaveLength(5 + 2);
    expect(result.counts.injected).toBe(ALBARAN_CHUNK_SIZE + 5);
  });

  it("counts a FALSE mark as matched-but-not-marked and logs it as an error", async () => {
    const h = harness({
      injected: [{ id: "a", numped: 501 }],
      rows: [[{ NUMPED: 501, NUMALB: 88 }]],
      mark: () => Promise.resolve(false),
    });
    const result = await runAlbaranSync(h.deps);

    expect(result.counts).toEqual({ injected: 1, matched: 1, marked: 0 });
    const alert = h.lines.find((l) => l.message.includes("mark_albaran"));
    expect(alert?.level).toBe("ERROR");
  });

  it("keeps going when one mark throws", async () => {
    const h = harness({
      injected: [
        { id: "a", numped: 501 },
        { id: "b", numped: 502 },
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
    expect(result.counts).toEqual({ injected: 2, matched: 2, marked: 1 });
  });

  it("ignores an albfacca row whose NUMALB is not usable", async () => {
    const h = harness({
      injected: [{ id: "a", numped: 501 }],
      rows: [[{ NUMPED: 501, NUMALB: 0 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([]);
    expect(result.counts).toEqual({ injected: 1, matched: 0, marked: 0 });
    expect(h.lines.some((l) => l.level === "WARN")).toBe(true);
  });

  it("ignores a NUMPED the portal is not waiting for", async () => {
    const h = harness({
      injected: [{ id: "a", numped: 501 }],
      rows: [[{ NUMPED: 999, NUMALB: 88 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([]);
    expect(result.counts.matched).toBe(0);
  });

  it("reports injected orders that carry no numped at all", async () => {
    const h = harness({ injected: [{ id: "a", numped: null }] });
    const result = await runAlbaranSync(h.deps);

    expect(result.counts.injected).toBe(0);
    const alert = h.lines.find((l) => l.level === "ERROR");
    expect(alert?.fields).toMatchObject({ count: 1, orderIds: "a" });
  });

  it("marks every order sharing a numped and warns about the collision", async () => {
    const h = harness({
      injected: [
        { id: "a", numped: 501 },
        { id: "b", numped: 501 },
      ],
      rows: [[{ NUMPED: 501, NUMALB: 88 }]],
    });
    const result = await runAlbaranSync(h.deps);

    expect(h.marks).toEqual([
      { orderId: "a", numalb: 88 },
      { orderId: "b", numalb: 88 },
    ]);
    expect(result.counts).toEqual({ injected: 1, matched: 1, marked: 2 });
    expect(h.lines.some((l) => l.level === "WARN")).toBe(true);
  });
});
