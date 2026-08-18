import { describe, expect, it } from "vitest";
import {
  BRIDGE_JOBS,
  BRIDGE_STALE_MS,
  bridgeCountLabelKey,
  bridgeStateKey,
  deriveBridgeBusinessHealth,
  deriveBridgeStatus,
  deriveBridgeStatuses,
  formatMadridTime,
  isBridgeJob,
  readBridgeDetail,
  relativeAge,
  type BridgeJob,
  type BridgeStatusRow,
} from "./bridge-status";

const NOW = new Date("2026-08-16T10:00:00Z");

/** A heartbeat row `ageMs` old, as the bridge would have written it. */
function row(
  job: BridgeJob,
  ageMs: number,
  ok: boolean,
  detail: unknown = null,
): BridgeStatusRow {
  return {
    job,
    last_run_at: new Date(NOW.getTime() - ageMs).toISOString(),
    ok,
    detail,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("deriveBridgeStatus — freshness", () => {
  const cases: Array<{
    name: string;
    job: BridgeJob;
    input: BridgeStatusRow | null;
    freshness: "fresh" | "stale" | "missing";
    tone: "good" | "busy" | "warn" | "bad";
  }> = [
    {
      name: "no row at all is missing, not healthy",
      job: "orders",
      input: null,
      freshness: "missing",
      tone: "warn",
    },
    {
      name: "a minute-old orders run is fresh",
      job: "orders",
      input: row("orders", MINUTE, true, { claimed: 0 }),
      freshness: "fresh",
      tone: "good",
    },
    {
      name: "an orders run older than ten minutes is stale",
      job: "orders",
      input: row("orders", 11 * MINUTE, true, { claimed: 3, injected: 3 }),
      freshness: "stale",
      tone: "warn",
    },
    {
      name: "albaran-sync is judged on its hourly cadence, not on orders'",
      job: "albaran-sync",
      input: row("albaran-sync", 30 * MINUTE, true, { injected: 2 }),
      freshness: "fresh",
      tone: "good",
    },
    {
      name: "…and goes stale after three missed hours",
      job: "albaran-sync",
      input: row("albaran-sync", 4 * HOUR, true, { injected: 2 }),
      freshness: "stale",
      tone: "warn",
    },
    {
      name: "a price-sync from last night is still fresh at ten in the morning",
      job: "price-sync",
      input: row("price-sync", 20 * HOUR, true, { articles: 3000 }),
      freshness: "fresh",
      tone: "good",
    },
    {
      name: "…and stale once a whole night has been missed",
      job: "price-sync",
      input: row("price-sync", 27 * HOUR, true, { articles: 3000 }),
      freshness: "stale",
      tone: "warn",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const view = deriveBridgeStatus(testCase.job, testCase.input, NOW);
      expect(view.freshness).toBe(testCase.freshness);
      expect(view.tone).toBe(testCase.tone);
    });
  }

  it("uses each job's own window, exactly at the boundary", () => {
    for (const job of BRIDGE_JOBS) {
      const atLimit = deriveBridgeStatus(job, row(job, BRIDGE_STALE_MS[job], true), NOW);
      const justInside = deriveBridgeStatus(
        job,
        row(job, BRIDGE_STALE_MS[job] - 1, true),
        NOW,
      );
      expect(atLimit.freshness).toBe("stale");
      expect(justInside.freshness).toBe("fresh");
    }
  });

  it("treats an unparseable timestamp as no timestamp", () => {
    const view = deriveBridgeStatus(
      "orders",
      { job: "orders", last_run_at: "not a date", ok: true, detail: null },
      NOW,
    );
    expect(view.freshness).toBe("missing");
    expect(view.lastRunAt).toBeNull();
    expect(view.ageMs).toBeNull();
  });

  it("does not turn a future timestamp amber — the ERP clock is in another zone", () => {
    // A row stamped ten minutes from now (server clock skew) must read as a
    // fresh run, not as one that is 'negatively stale'.
    const view = deriveBridgeStatus("orders", row("orders", -10 * MINUTE, true), NOW);
    expect(view.freshness).toBe("fresh");
    expect(view.ageMs).toBe(0);
  });
});

describe("deriveBridgeStatus — outcome", () => {
  it("reads a successful run as ok", () => {
    const view = deriveBridgeStatus("orders", row("orders", MINUTE, true, { claimed: 0 }), NOW);
    expect(view.outcome).toBe("ok");
    expect(view.businessHealth).toBe("healthy");
    expect(view.tone).toBe("good");
    expect(view.code).toBeNull();
  });

  it("reads LOCK_HELD as busy, never as failure", () => {
    // The orders job runs every minute and overruns sometimes; the lock is
    // doing its job, and painting it red would train staff to ignore red.
    const view = deriveBridgeStatus(
      "orders",
      row("orders", MINUTE, false, { code: "LOCK_HELD" }),
      NOW,
    );
    expect(view.outcome).toBe("busy");
    expect(view.tone).toBe("busy");
    expect(view.code).toBe("LOCK_HELD");
  });

  it("reads RUN_FAILED as a real failure — the key is `code`, not `error`", () => {
    const view = deriveBridgeStatus(
      "orders",
      row("orders", MINUTE, false, { code: "RUN_FAILED" }),
      NOW,
    );
    expect(view.outcome).toBe("failed");
    expect(view.tone).toBe("bad");
    expect(view.code).toBe("RUN_FAILED");
  });

  it("reads any other ok:false as a failure, with or without a code", () => {
    for (const detail of [{ code: "LOCK_FAILED" }, { code: "SOMETHING_NEW" }, null, {}]) {
      const view = deriveBridgeStatus("orders", row("orders", MINUTE, false, detail), NOW);
      expect(view.outcome).toBe("failed");
      expect(view.tone).toBe("bad");
    }
  });

  it("keeps the outcome when the row is stale, and lets a failure outrank silence", () => {
    const staleOk = deriveBridgeStatus("orders", row("orders", HOUR, true, { claimed: 1 }), NOW);
    expect(staleOk).toMatchObject({ freshness: "stale", outcome: "ok", tone: "warn" });

    const staleBusy = deriveBridgeStatus(
      "orders",
      row("orders", HOUR, false, { code: "LOCK_HELD" }),
      NOW,
    );
    // A lock that has been held for an hour is not "busy, all good": nothing has
    // run. Amber, and the code is still there to name the file to delete.
    expect(staleBusy).toMatchObject({ freshness: "stale", outcome: "busy", tone: "warn" });

    const staleFailed = deriveBridgeStatus(
      "orders",
      row("orders", HOUR, false, { code: "RUN_FAILED" }),
      NOW,
    );
    expect(staleFailed).toMatchObject({ freshness: "stale", outcome: "failed", tone: "bad" });
  });
});

describe("deriveBridgeBusinessHealth — completed run contents", () => {
  it("keeps `ok` as the program outcome while a retried order turns the card amber", () => {
    const view = deriveBridgeStatus(
      "orders",
      row("orders", MINUTE, true, {
        claimed: 3,
        injected: 2,
        recovered: 0,
        failed: 1,
        requeued: 1,
        terminal: 0,
        markFailed: 0,
        failureMarkFailed: 0,
      }),
      NOW,
    );

    expect(view).toMatchObject({
      outcome: "ok",
      businessHealth: "degraded",
      tone: "warn",
    });
    expect(bridgeStateKey(view)).toBe("degraded");
  });

  it("keeps the next empty run red while a manual backlog still exists", () => {
    const view = deriveBridgeStatus(
      "orders",
      row("orders", MINUTE, true, {
        claimed: 0,
        injected: 0,
        recovered: 0,
        failed: 0,
        requeued: 0,
        terminal: 0,
        markFailed: 0,
        failureMarkFailed: 0,
        manualRequired: 1,
        retryPending: 0,
        processingPending: 0,
        backlogCountError: 0,
      }),
      NOW,
    );

    expect(view).toMatchObject({
      outcome: "ok",
      businessHealth: "failed",
      tone: "bad",
    });
    expect(bridgeStateKey(view)).toBe("businessFailed");
  });

  it("keeps the next empty run amber while a retry backlog still exists", () => {
    const view = deriveBridgeStatus(
      "orders",
      row("orders", MINUTE, true, {
        claimed: 0,
        failed: 0,
        requeued: 0,
        terminal: 0,
        markFailed: 0,
        failureMarkFailed: 0,
        manualRequired: 0,
        retryPending: 2,
        processingPending: 0,
        backlogCountError: 0,
      }),
      NOW,
    );

    expect(view).toMatchObject({
      outcome: "ok",
      businessHealth: "degraded",
      tone: "warn",
    });
    expect(bridgeStateKey(view)).toBe("degraded");
  });

  it("keeps a fully requeued transient batch amber", () => {
    const view = deriveBridgeStatus(
      "orders",
      row("orders", MINUTE, true, {
        claimed: 2,
        injected: 0,
        recovered: 0,
        failed: 2,
        requeued: 2,
        terminal: 0,
        markFailed: 0,
        failureMarkFailed: 0,
        manualRequired: 0,
        retryPending: 2,
        processingPending: 0,
        backlogCountError: 0,
      }),
      NOW,
    );

    expect(view).toMatchObject({
      outcome: "ok",
      businessHealth: "degraded",
      tone: "warn",
    });
    expect(bridgeStateKey(view)).toBe("degraded");
  });

  it.each([
    "terminal",
    "markFailed",
    "failureMarkFailed",
    "manualRequired",
    "processingPending",
    "backlogCountError",
  ])(
    "treats %s as requiring human attention",
    (key) => {
      const view = deriveBridgeStatus(
        "orders",
        row("orders", MINUTE, true, {
          claimed: 2,
          injected: 1,
          failed: 1,
          [key]: 1,
        }),
        NOW,
      );
      expect(view.businessHealth).toBe("failed");
      expect(view.tone).toBe("bad");
      expect(bridgeStateKey(view)).toBe("businessFailed");
    },
  );

  it("lets a persistent red condition outrank a retry backlog", () => {
    expect(
      deriveBridgeBusinessHealth("orders", [
        { key: "manualRequired", value: 1 },
        { key: "retryPending", value: 4 },
      ]),
    ).toBe("failed");
  });

  it("does not apply orders-only counters to the other jobs", () => {
    expect(
      deriveBridgeBusinessHealth("price-sync", [
        { key: "failed", value: 10 },
        { key: "terminal", value: 10 },
      ]),
    ).toBe("healthy");
  });

  it("treats Albarán identity or mark failures as failed business health", () => {
    expect(
      deriveBridgeBusinessHealth("albaran-sync", [{ key: "failed", value: 1 }]),
    ).toBe("failed");
    expect(
      deriveBridgeStatus(
        "albaran-sync",
        row("albaran-sync", MINUTE, true, { injected: 2, failed: 1 }),
        NOW,
      ),
    ).toMatchObject({
      outcome: "ok",
      businessHealth: "failed",
      tone: "bad",
    });
  });

  it("does not invent a failure from absent, null or non-positive counts", () => {
    expect(
      deriveBridgeBusinessHealth("orders", [
        { key: "claimed", value: null },
        { key: "failed", value: 0 },
        { key: "terminal", value: -1 },
      ]),
    ).toBe("healthy");
  });
});

describe("readBridgeDetail", () => {
  it("unpacks an orders run's counts in the order the job emits them", () => {
    const detail = { claimed: 3, injected: 2, recovered: 1, markFailed: 0, failed: 0 };
    const read = readBridgeDetail(detail);
    expect(read.counts.map((count) => count.key)).toEqual([
      "claimed",
      "injected",
      "recovered",
      "markFailed",
      "failed",
    ]);
    expect(read.counts.map((count) => count.value)).toEqual([3, 2, 1, 0, 0]);
    expect(read.code).toBeNull();
    expect(read.notes).toEqual([]);
  });

  it("keeps a null count as null — 'not counted' is not zero", () => {
    const read = readBridgeDetail({ articles: 2, fullyUnpriced: null });
    expect(read.counts).toEqual([
      { key: "articles", value: 2 },
      { key: "fullyUnpriced", value: null },
    ]);
  });

  it("separates the code and the price-sync sample from the counts", () => {
    const read = readBridgeDetail({
      articles: 10,
      notInPortal: 2,
      notInPortalSample: ["A1", "B2"],
      code: "RUN_FAILED",
    });
    expect(read.code).toBe("RUN_FAILED");
    expect(read.sample).toEqual(["A1", "B2"]);
    expect(read.counts.map((count) => count.key)).toEqual(["articles", "notInPortal"]);
  });

  it("caps the sample at twenty and drops non-strings", () => {
    const sample = Array.from({ length: 30 }, (_, index) => `ART${index}`);
    expect(readBridgeDetail({ notInPortalSample: sample }).sample).toHaveLength(20);
    expect(readBridgeDetail({ notInPortalSample: ["A", 7, null] }).sample).toEqual(["A"]);
  });

  it("puts text fields in notes, where a long message cannot pose as a count", () => {
    const read = readBridgeDetail({ matched: 1, error: "socket hang up" });
    expect(read.counts).toEqual([{ key: "matched", value: 1 }]);
    expect(read.notes).toEqual([{ key: "error", value: "socket hang up" }]);
  });

  it("puts a boolean in notes too — `true` in a row of numbers reads as one", () => {
    const read = readBridgeDetail({ matched: 1, degraded: true, retried: false });
    expect(read.counts).toEqual([{ key: "matched", value: 1 }]);
    expect(read.notes).toEqual([
      { key: "degraded", value: "true" },
      // `false` is kept, unlike an empty string: it is an answer, not a blank.
      { key: "retried", value: "false" },
    ]);
  });

  it("drops an empty string — a note with nothing in it is not a note", () => {
    expect(readBridgeDetail({ error: "" }).notes).toEqual([]);
  });

  it("survives a detail that is not an object", () => {
    for (const detail of [null, undefined, 7, "oops", ["a"], true]) {
      expect(readBridgeDetail(detail)).toEqual({
        code: null,
        counts: [],
        notes: [],
        sample: [],
      });
    }
  });

  it("ignores NaN and Infinity, which JSON cannot carry anyway", () => {
    expect(readBridgeDetail({ claimed: Number.NaN, failed: Number.POSITIVE_INFINITY }).counts)
      .toEqual([]);
  });
});

describe("deriveBridgeStatuses", () => {
  it("lists all three jobs even when the table holds none of them", () => {
    const views = deriveBridgeStatuses([], NOW);
    expect(views.map((view) => view.job)).toEqual([...BRIDGE_JOBS]);
    expect(views.every((view) => view.freshness === "missing")).toBe(true);
  });

  it("names the job that is missing while the others are healthy", () => {
    // The shape of a bridge deployed with two scheduled tasks out of three: the
    // absent row is the whole point of the card.
    const views = deriveBridgeStatuses(
      [row("orders", MINUTE, true, { claimed: 0 }), row("albaran-sync", MINUTE, true, {})],
      NOW,
    );
    expect(views.map((view) => view.freshness)).toEqual(["fresh", "fresh", "missing"]);
  });

  it("ignores a row for a job this build does not know", () => {
    const views = deriveBridgeStatuses(
      [{ job: "stock-sync", last_run_at: NOW.toISOString(), ok: true, detail: null }],
      NOW,
    );
    expect(views).toHaveLength(BRIDGE_JOBS.length);
    expect(views.every((view) => view.freshness === "missing")).toBe(true);
  });
});

describe("bridgeStateKey", () => {
  const cases: Array<[string, BridgeStatusRow | null, string, string]> = [
    ["a fresh success", row("orders", MINUTE, true, { claimed: 0 }), "ok", "good"],
    ["a fresh lock", row("orders", MINUTE, false, { code: "LOCK_HELD" }), "busy", "busy"],
    ["a fresh failure", row("orders", MINUTE, false, { code: "RUN_FAILED" }), "failed", "bad"],
    ["a stale success", row("orders", HOUR, true, { claimed: 0 }), "stale", "warn"],
    ["a stale lock", row("orders", HOUR, false, { code: "LOCK_HELD" }), "stale", "warn"],
    ["a stale failure", row("orders", HOUR, false, { code: "RUN_FAILED" }), "failed", "bad"],
    [
      "a completed run with a retry",
      row("orders", MINUTE, true, { claimed: 2, injected: 1, failed: 1, requeued: 1 }),
      "degraded",
      "warn",
    ],
    [
      "a completed run with a terminal order",
      row("orders", MINUTE, true, { claimed: 2, injected: 1, failed: 1, terminal: 1 }),
      "businessFailed",
      "bad",
    ],
    ["no row", null, "missing", "warn"],
  ];

  for (const [name, input, key, tone] of cases) {
    it(`labels ${name} as ${key}`, () => {
      const view = deriveBridgeStatus("orders", input, NOW);
      expect(bridgeStateKey(view)).toBe(key);
      // The badge word and the badge colour are derived from the same facts, so
      // a card can never say 正常 in amber.
      expect(view.tone).toBe(tone);
    });
  }
});

describe("relativeAge", () => {
  it("picks the largest whole unit that fits", () => {
    expect(relativeAge(0)).toEqual({ value: 0, unit: "second" });
    expect(relativeAge(59_000)).toEqual({ value: 59, unit: "second" });
    expect(relativeAge(3 * MINUTE)).toEqual({ value: 3, unit: "minute" });
    expect(relativeAge(59 * MINUTE + 59_000)).toEqual({ value: 59, unit: "minute" });
    expect(relativeAge(2 * HOUR)).toEqual({ value: 2, unit: "hour" });
    expect(relativeAge(23 * HOUR)).toEqual({ value: 23, unit: "hour" });
    expect(relativeAge(25 * HOUR)).toEqual({ value: 1, unit: "day" });
    expect(relativeAge(9 * 24 * HOUR)).toEqual({ value: 9, unit: "day" });
  });

  it("never reports a negative age", () => {
    expect(relativeAge(-5_000)).toEqual({ value: 0, unit: "second" });
  });
});

describe("formatMadridTime", () => {
  it("renders the moment on Madrid's clock, not the ERP server's", () => {
    // 10:00 UTC in August is 12:00 in Madrid (CEST). The bridge's own host runs
    // on China time; nothing of that may reach the card.
    expect(formatMadridTime("2026-08-16T10:00:00Z", "es")).toContain("12:00");
    expect(formatMadridTime("2026-08-16T10:00:00Z", "zh")).toContain("12:00");
    // Winter is CET, one hour off UTC.
    expect(formatMadridTime("2026-01-16T10:00:00Z", "es")).toContain("11:00");
  });

  it("returns an empty string for an unusable value", () => {
    expect(formatMadridTime("not a date", "zh")).toBe("");
  });
});

describe("guards", () => {
  it("recognises the three jobs and nothing else", () => {
    for (const job of BRIDGE_JOBS) expect(isBridgeJob(job)).toBe(true);
    expect(isBridgeJob("orders ")).toBe(false);
    expect(isBridgeJob("stock-sync")).toBe(false);
  });
});

describe("bridgeCountLabelKey", () => {
  it("scopes the SAME key to the job that emitted it", () => {
    // `injected` means two different things: orders written into Wingest this
    // run, versus orders still waiting for an albarán. One flat label for both
    // told staff four orders had been injected in an hour when none had.
    expect(bridgeCountLabelKey("orders", "injected")).toBe("orders.injected");
    expect(bridgeCountLabelKey("albaran-sync", "injected")).toBe("albaran-sync.injected");
  });

  it("labels every count each job actually emits", () => {
    const emitted: Record<BridgeJob, string[]> = {
      // ordersCounts / albaranCounts / priceSyncCounts, key for key.
      orders: [
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
      ],
      "albaran-sync": ["injected", "matched", "marked", "failed"],
      "price-sync": [
        "articles",
        "matched",
        "notInPortal",
        "fullyUnpriced",
        "orderableWithPrice",
        "skipped",
        "error",
        "countError",
      ],
    };
    for (const job of BRIDGE_JOBS) {
      for (const key of emitted[job]) {
        expect(bridgeCountLabelKey(job, key)).toBe(`${job}.${key}`);
      }
    }
  });

  it("returns null for a key that belongs to another job, or to none", () => {
    // A wrong label is worse than a bare key: the card falls back to the raw
    // one rather than borrowing a neighbour's word for it.
    expect(bridgeCountLabelKey("orders", "articles")).toBeNull();
    expect(bridgeCountLabelKey("albaran-sync", "claimed")).toBeNull();
    expect(bridgeCountLabelKey("price-sync", "markFailed")).toBeNull();
    expect(bridgeCountLabelKey("orders", "somethingNew")).toBeNull();
  });
});
