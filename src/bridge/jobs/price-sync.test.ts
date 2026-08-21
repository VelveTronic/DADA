import type { WingestPricePatch } from "@/lib/catalog/wingest";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../config";
import type { SqlParent } from "../injector";
import type { LogFields, Logger } from "../log";
import {
  ARTICULO_PRICE_SQL,
  FULLY_UNPRICED_FILTERS,
  ORDERABLE_WITH_PRICE_FILTERS,
  emptyPriceSyncTally,
  priceSyncCounts,
  runPriceSync,
  toPriceRow,
  type PriceSyncDeps,
} from "./price-sync";

const cfg: BridgeConfig = {
  supabaseUrl: "https://project.supabase.co",
  supabaseServiceRoleKey: "service-key",
  wingestServer: "localhost",
  wingestPort: 50352,
  wingestDb: "wgdemo",
  wingestUser: "dada_bridge",
  wingestPassword: "pw",
  erpUser: "SFY",
  can: "B",
  eje: 26,
  allowHistoricalEje: false,
  historicalOrderId: null,
  alm: "00001",
  lotAllowExpired: false,
  lotExpiredMaxDays: 0,
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
};

const NOW = new Date("2026-08-16T04:30:00.000Z");

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
  deps: PriceSyncDeps;
  lines: Line[];
  queries: string[];
  patches: { codart: string; patch: WingestPricePatch }[];
  countFilters: Record<string, string>[];
  closes: () => number;
}

function harness(options: {
  rows: Record<string, unknown>[];
  patch?: (codart: string) => Promise<boolean>;
  count?: (filters: Record<string, string>) => Promise<number | null>;
}): Harness {
  const { log, lines } = recorder();
  const queries: string[] = [];
  const patches: Harness["patches"] = [];
  const countFilters: Record<string, string>[] = [];
  const state = { closes: 0 };

  const pool = {
    request() {
      return {
        query(text: string) {
          queries.push(text);
          return Promise.resolve({ recordset: options.rows, recordsets: [options.rows] });
        },
      };
    },
    close() {
      state.closes++;
      return Promise.resolve();
    },
  };

  const deps: PriceSyncDeps = {
    cfg,
    log,
    now: () => NOW,
    api: {
      patchProduct: (codart, patch) => {
        patches.push({ codart, patch: patch as WingestPricePatch });
        return options.patch ? options.patch(codart) : Promise.resolve(true);
      },
      countProducts: (filters) => {
        countFilters.push(filters);
        return options.count ? options.count(filters) : Promise.resolve(0);
      },
    },
    connect: () =>
      Promise.resolve(pool as unknown as SqlParent & { close(): Promise<unknown> }),
  };

  return { deps, lines, queries, patches, countFilters, closes: () => state.closes };
}

function articulo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    codart: "4-007",
    PREVENA: 19.99,
    PREVENB: 18.5,
    PREVENC: 0,
    PREVEND: 0,
    PREVENE: 0,
    PREVENF: 0,
    unidad: "UNIDAD",
    UNILOT: 6,
    ...overrides,
  };
}

describe("ARTICULO_PRICE_SQL", () => {
  it("is the same projection the PowerShell export produces", () => {
    // RTRIM matters: CODART and UNIDAD are char columns, and a padded codart
    // matches no product in the portal.
    expect(ARTICULO_PRICE_SQL).toContain("RTRIM(CODART) AS codart");
    expect(ARTICULO_PRICE_SQL).toContain("RTRIM(UNIDAD) AS unidad");
    expect(ARTICULO_PRICE_SQL).toContain(
      "PREVENA, PREVENB, PREVENC, PREVEND, PREVENE, PREVENF",
    );
    expect(ARTICULO_PRICE_SQL).toContain("FROM articulo");
  });

  /**
   * UNILOT is the caja factor, and this run IS its backfill: the portal
   * multiplies every price by it, so a projection that stopped selecting it
   * would leave 3,000 products silently priced per bottle on a page that says
   * caja.
   */
  it("selects UNILOT, the factor the whole caja price rests on", () => {
    expect(ARTICULO_PRICE_SQL).toContain("UNILOT");
  });

  it("reads and nothing else", () => {
    expect(ARTICULO_PRICE_SQL).not.toMatch(/INSERT|UPDATE|DELETE|MERGE/i);
  });
});

describe("toPriceRow", () => {
  it("stringifies the ERP columns into the CSV-shaped row", () => {
    expect(toPriceRow(articulo())).toEqual({
      codart: "4-007",
      p1: "19.99",
      p2: "18.5",
      p3: "0",
      p4: "0",
      p5: "0",
      p6: "0",
      unidad: "UNIDAD",
      unilot: "6",
    });
  });

  it("turns NULL columns into the empty string the transform expects", () => {
    const row = toPriceRow(
      articulo({ PREVENA: null, unidad: null, UNILOT: null, PREVENB: undefined }),
    );
    expect(row.p1).toBe("");
    expect(row.p2).toBe("");
    expect(row.unidad).toBe("");
    expect(row.unilot).toBe("");
  });

  it("trims a codart the driver handed back padded", () => {
    expect(toPriceRow(articulo({ codart: "4-007  " })).codart).toBe("4-007");
  });

  it("keeps a zero distinguishable from a null", () => {
    // "0" means the ERP holds a zero price; "" means it holds nothing. Both end
    // up NULL in the catalog, but only via different branches of the transform.
    expect(toPriceRow(articulo({ PREVENC: 0 })).p3).toBe("0");
    expect(toPriceRow(articulo({ PREVENC: null })).p3).toBe("");
  });
});

describe("priceSyncCounts", () => {
  it("emits the five fields the plan names", () => {
    expect(Object.keys(priceSyncCounts(emptyPriceSyncTally()))).toEqual([
      "articles",
      "matched",
      "notInPortal",
      "fullyUnpriced",
      "orderableWithPrice",
    ]);
  });

  it("adds skipped only when a row had to be skipped", () => {
    const counts = priceSyncCounts({ ...emptyPriceSyncTally(), skipped: 2 });
    expect(counts.skipped).toBe(2);
  });

  it("carries the two failure notes when they are set", () => {
    const counts = priceSyncCounts({
      ...emptyPriceSyncTally(),
      countError: "timeout",
      error: "network down",
    });
    expect(counts).toMatchObject({ countError: "timeout", error: "network down" });
  });

  it("carries the unmatched sample as an array, for the staff card", () => {
    const counts = priceSyncCounts({
      ...emptyPriceSyncTally(),
      notInPortal: 2,
      notInPortalSample: ["A-1", "B-2"],
    });
    // An array, not the log line's flat "A-1,B-2": `detail` is jsonb and the
    // card renders the codarts one by one.
    expect(counts.notInPortalSample).toEqual(["A-1", "B-2"]);
  });

  it("copies the sample rather than aliasing the tally's own array", () => {
    const tally = { ...emptyPriceSyncTally(), notInPortalSample: ["A-1"] };
    const counts = priceSyncCounts(tally);
    tally.notInPortalSample.push("B-2");
    expect(counts.notInPortalSample).toEqual(["A-1"]);
  });

  it("omits the sample when every article matched", () => {
    expect(priceSyncCounts(emptyPriceSyncTally())).not.toHaveProperty("notInPortalSample");
  });
});

describe("runPriceSync", () => {
  it("reads articulo once and closes the ERP connection before patching", async () => {
    const h = harness({ rows: [articulo()] });
    await runPriceSync(h.deps);

    expect(h.queries).toEqual([ARTICULO_PRICE_SQL]);
    expect(h.closes()).toBe(1);
  });

  it("applies the SAME merge semantics as the CSV importer", async () => {
    const h = harness({
      rows: [articulo({ codart: "5-100", unidad: "KG", PREVENC: 2.5, UNILOT: 0 })],
    });
    await runPriceSync(h.deps);

    expect(h.patches).toHaveLength(1);
    expect(h.patches[0].codart).toBe("5-100");
    expect(h.patches[0].patch).toEqual({
      price_1_cents: 1999,
      price_2_cents: 1850,
      price_3_cents: 250,
      // A zero tier is "no price", never a free product.
      price_4_cents: null,
      price_5_cents: null,
      price_6_cents: null,
      // UNILOT 0 is "not sold by the case": the factor is 1, the value that
      // leaves the per-caja price equal to the base price.
      units_per_case: 1,
      erp_synced_at: NOW.toISOString(),
      unit: "KG",
      is_weighed: true,
    });
  });

  it("never clears a unit the ERP does not have", async () => {
    const h = harness({ rows: [articulo({ unidad: "" })] });
    await runPriceSync(h.deps);

    expect(h.patches[0].patch.unit).toBeUndefined();
    expect(h.patches[0].patch.is_weighed).toBeUndefined();
  });

  it("stamps every row of one run with the same erp_synced_at", async () => {
    const h = harness({
      rows: [articulo(), articulo({ codart: "4-008" }), articulo({ codart: "4-009" })],
    });
    await runPriceSync(h.deps);

    const stamps = new Set(h.patches.map((p) => p.patch.erp_synced_at));
    expect(stamps.size).toBe(1);
  });

  it("counts articles the portal does not carry", async () => {
    const h = harness({
      rows: [articulo({ codart: "A" }), articulo({ codart: "B" }), articulo({ codart: "C" })],
      patch: (codart) => Promise.resolve(codart !== "B"),
    });
    const result = await runPriceSync(h.deps);

    expect(result.counts).toMatchObject({ articles: 3, matched: 2, notInPortal: 1 });
    expect(result.ok).toBe(true);
  });

  it("names the first unmatched codarts, as the CSV importer does", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => articulo({ codart: `X-${i}` }));
    const h = harness({ rows, patch: () => Promise.resolve(false) });
    await runPriceSync(h.deps);

    const merged = h.lines.find((l) => l.message === "merged");
    const sample = String(merged?.fields.sample).split(",");
    // Twenty is the cap: a count alone cannot tell "the ERP's own packaging
    // articles" from "a product family the portal import missed".
    expect(sample).toHaveLength(20);
    expect(sample[0]).toBe("X-0");
  });

  it("leaves the sample off when every article matched", async () => {
    const h = harness({ rows: [articulo()] });
    const { counts } = await runPriceSync(h.deps);

    const merged = h.lines.find((l) => l.message === "merged");
    expect(merged?.fields.sample).toBeNull();
    expect(counts).not.toHaveProperty("notInPortalSample");
  });

  it("sends the same first-twenty sample to the heartbeat as to the log", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => articulo({ codart: `X-${i}` }));
    const h = harness({ rows, patch: () => Promise.resolve(false) });
    const { counts } = await runPriceSync(h.deps);

    const merged = h.lines.find((l) => l.message === "merged");
    expect(counts.notInPortalSample).toHaveLength(20);
    expect(counts.notInPortalSample).toEqual(String(merged?.fields.sample).split(","));
    expect(counts.notInPortal).toBe(25);
  });

  it("reports what it saw even when the merge broke half way", async () => {
    const rows = [
      articulo({ codart: "A" }),
      articulo({ codart: "B" }),
      articulo({ codart: "C" }),
    ];
    const h = harness({
      rows,
      patch: (codart) => {
        if (codart === "C") throw new Error("socket hang up");
        return Promise.resolve(false);
      },
    });
    const { ok, counts } = await runPriceSync(h.deps);

    expect(ok).toBe(false);
    expect(counts.notInPortalSample).toEqual(["A", "B"]);
  });

  it("keeps matched + notInPortal + skipped equal to articles", async () => {
    const h = harness({
      rows: [articulo({ codart: "A" }), articulo({ codart: "  " }), articulo({ codart: "C" })],
      patch: (codart) => Promise.resolve(codart !== "C"),
    });
    const { counts } = await runPriceSync(h.deps);

    expect(
      Number(counts.matched) + Number(counts.notInPortal) + Number(counts.skipped),
    ).toBe(counts.articles);
    expect(counts.skipped).toBe(1);
  });

  it("skips a row with no codart and says which position it was", async () => {
    const h = harness({ rows: [articulo({ codart: null })] });
    await runPriceSync(h.deps);

    expect(h.patches).toEqual([]);
    const warning = h.lines.find((l) => l.level === "WARN");
    expect(warning?.fields).toMatchObject({ position: 1 });
  });

  it("runs the two post-merge counts and reports them", async () => {
    const h = harness({
      rows: [articulo()],
      count: (filters) => Promise.resolve(filters.is_orderable ? 2871 : 102),
    });
    const result = await runPriceSync(h.deps);

    expect(h.countFilters).toEqual([FULLY_UNPRICED_FILTERS, ORDERABLE_WITH_PRICE_FILTERS]);
    expect(result.counts).toMatchObject({ fullyUnpriced: 102, orderableWithPrice: 2871 });
  });

  it("tolerates a failed diagnostic count — the merge already happened", async () => {
    const h = harness({
      rows: [articulo()],
      count: () => Promise.reject(new Error("statement timeout")),
    });
    const result = await runPriceSync(h.deps);

    expect(result.ok).toBe(true);
    expect(result.counts.matched).toBe(1);
    expect(result.counts.countError).toContain("statement timeout");
    expect(result.counts.fullyUnpriced).toBeNull();
  });

  it("stops on a failed patch, reports how far it got, and fails the run", async () => {
    const h = harness({
      rows: [articulo({ codart: "A" }), articulo({ codart: "B" }), articulo({ codart: "C" })],
      patch: (codart) =>
        codart === "B"
          ? Promise.reject(new Error("permission denied for table products"))
          : Promise.resolve(true),
    });
    const result = await runPriceSync(h.deps);

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({ articles: 3, matched: 1 });
    expect(result.counts.error).toContain("permission denied");
    // The failure names the article and the position, so a re-run is a decision
    // rather than a guess.
    const failure = h.lines.find((l) => l.fields.stage === "patch");
    expect(failure?.fields).toMatchObject({ codart: "B", position: "2/3" });
    // Diagnostics still run: they describe the state the partial merge left.
    expect(h.countFilters).toHaveLength(2);
  });

  it("handles an empty catalog without touching the portal", async () => {
    const h = harness({ rows: [] });
    const result = await runPriceSync(h.deps);

    expect(h.patches).toEqual([]);
    expect(result.counts.articles).toBe(0);
    expect(result.ok).toBe(true);
  });
});

describe("the diagnostic filters", () => {
  it("ask for products with no price on any tier", () => {
    expect(Object.keys(FULLY_UNPRICED_FILTERS)).toHaveLength(6);
    for (const value of Object.values(FULLY_UNPRICED_FILTERS)) {
      expect(value).toBe("is.null");
    }
  });

  it("ask for orderable products priced on at least one tier", () => {
    expect(ORDERABLE_WITH_PRICE_FILTERS.is_orderable).toBe("eq.true");
    expect(ORDERABLE_WITH_PRICE_FILTERS.or.match(/not\.is\.null/g)).toHaveLength(6);
  });
});
