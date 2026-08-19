import { describe, expect, it } from "vitest";
import {
  CATEGORY_ERRORS,
  compareCategories,
  isCategoryError,
  makePortalErpCode,
  MAX_CATEGORY_NAME_LENGTH,
  moveCategory,
  parseActiveFlag,
  parseCategoryId,
  parseMoveDirection,
  resequence,
  SORT_STEP,
  sortCategories,
  validateCategoryName,
} from "./categories";

/**
 * One category row, as the two pages read it.
 *
 * The names are deliberately ASCII wherever the ORDER is asserted: what these
 * tests pin down is the rule (number first, then the label this locale shows),
 * not ICU's collation of Han characters against Latin ones, which is a property
 * of the platform and not of this file.
 */
function cat(id: number, sort_order: number, zh?: string, es?: string) {
  const name: Record<string, string> = {};
  if (zh !== undefined) name.zh = zh;
  if (es !== undefined) name.es = es;
  return { id, sort_order, name };
}

/** A re-sequence written back onto the rows it came from, for idempotence. */
function apply<T extends { id: number; sort_order: number }>(
  rows: readonly T[],
  sorts: readonly { id: number; sort_order: number }[],
): T[] {
  const next = new Map(sorts.map((row) => [row.id, row.sort_order]));
  return rows.map((row) => ({ ...row, sort_order: next.get(row.id) ?? row.sort_order }));
}

describe("compareCategories", () => {
  // Each row: two (sort_order, label) pairs and the sign the comparator owes.
  it.each([
    // The number wins outright, whatever the labels say.
    [1, "Zulu", 2, "Alfa", -1],
    [2, "Alfa", 1, "Zulu", 1],
    // A tie — the freepos default, where most rows sit on 0 — hands the
    // decision to the name.
    [0, "Alfa", 0, "Zulu", -1],
    [0, "Zulu", 0, "Alfa", 1],
    // Same number, same words: no opinion, so the input order survives.
    [0, "Alfa", 0, "Alfa", 0],
  ])(
    "(%i,%s) vs (%i,%s) → %i",
    (aSort, aLabel, bSort, bLabel, expected) => {
      const sign = Math.sign(
        compareCategories(
          { sort_order: aSort, label: aLabel },
          { sort_order: bSort, label: bLabel },
          "es",
        ),
      );
      expect(sign).toBe(expected);
    },
  );
});

describe("sortCategories", () => {
  it("labels a row with the name this locale shows, falling back across them", () => {
    const rows = [cat(1, 0, "饮料酒水"), cat(2, 0, undefined, "Conservas")];
    // A zh-only category still has to say something to a Spanish caller, and an
    // es-only one to a Chinese caller: `localizedName` falls back, and the
    // fallback is what the comparator then sorts on.
    expect(sortCategories(rows, "es").map((row) => row.label)).toEqual([
      "Conservas",
      "饮料酒水",
    ]);
    expect(
      sortCategories(rows, "zh")
        .map((row) => row.label)
        .sort(),
    ).toEqual(["Conservas", "饮料酒水"].sort());
  });

  it("breaks a tie in the locale's own words, so the two locales can disagree", () => {
    // The same two rows, named the other way round in each language. Nothing
    // else separates them — same sort_order — so the label is the whole answer,
    // and the answer is different for a zh caller and an es caller. This is the
    // collision `resequence` exists to end.
    const rows = [cat(1, 0, "Alfa", "Zulu"), cat(2, 0, "Zulu", "Alfa")];
    expect(sortCategories(rows, "zh").map((row) => row.id)).toEqual([1, 2]);
    expect(sortCategories(rows, "es").map((row) => row.id)).toEqual([2, 1]);
  });

  it("leaves the array it was handed alone", () => {
    const rows = [cat(1, 20, "Zulu"), cat(2, 10, "Alfa")];
    const ids = rows.map((row) => row.id);
    sortCategories(rows, "zh");
    expect(rows.map((row) => row.id)).toEqual(ids);
  });
});

describe("resequence", () => {
  it("turns the freepos collisions into a real sequence", () => {
    // Three of the 61 seeded categories carry the ERP's empty sort field, which
    // the importer reads as 0 (`scripts/seed-categories.ts:161`). Before the
    // first write the name is the whole order; after it, the numbers are.
    const rows = [cat(1, 0, "Charlie"), cat(2, 0, "Alfa"), cat(3, 0, "Bravo")];
    expect(resequence(rows, "zh")).toEqual([
      { id: 2, sort_order: 10 },
      { id: 3, sort_order: 20 },
      { id: 1, sort_order: 30 },
    ]);
  });

  it("keeps a gapped list's order while closing the gaps", () => {
    const rows = [cat(1, 5, "Alfa"), cat(2, 900, "Bravo"), cat(3, 7, "Charlie")];
    expect(resequence(rows, "zh")).toEqual([
      { id: 1, sort_order: 10 },
      { id: 3, sort_order: 20 },
      { id: 2, sort_order: 30 },
    ]);
  });

  it("is idempotent: a second run writes the same numbers", () => {
    const rows = [cat(1, 0, "Charlie"), cat(2, 0, "Alfa"), cat(3, 0, "Bravo")];
    const first = resequence(rows, "zh");
    expect(resequence(apply(rows, first), "zh")).toEqual(first);
  });

  it("numbers in strict steps from one step, never from zero", () => {
    // 0 is the column's default and the value every un-sequenced row already
    // holds, so a list whose first row was numbered 0 would be indistinguishable
    // from one that has never been touched.
    const rows = [cat(1, 0, "Alfa"), cat(2, 0, "Bravo")];
    expect(resequence(rows, "zh").map((row) => row.sort_order)).toEqual([
      SORT_STEP,
      SORT_STEP * 2,
    ]);
  });
});

describe("moveCategory", () => {
  const rows = [
    cat(1, 10, "Alfa"),
    cat(2, 20, "Bravo"),
    cat(3, 30, "Charlie"),
  ];

  it("swaps a middle row with the one above it", () => {
    expect(moveCategory(rows, 2, "up", "zh")).toEqual([
      { id: 2, sort_order: 10 },
      { id: 1, sort_order: 20 },
      { id: 3, sort_order: 30 },
    ]);
  });

  it("swaps a middle row with the one below it", () => {
    expect(moveCategory(rows, 2, "down", "zh")).toEqual([
      { id: 1, sort_order: 10 },
      { id: 3, sort_order: 20 },
      { id: 2, sort_order: 30 },
    ]);
  });

  it("changes exactly the two rows that swapped, once the list is sequenced", () => {
    const moved = moveCategory(rows, 2, "up", "zh") ?? [];
    const changed = moved.filter(
      (row) => rows.find((r) => r.id === row.id)?.sort_order !== row.sort_order,
    );
    // What the action writes back: two updates, not the whole table.
    expect(changed.map((row) => row.id).sort()).toEqual([1, 2]);
  });

  it("answers null at both ends and for an id it cannot see", () => {
    expect(moveCategory(rows, 1, "up", "zh")).toBeNull();
    expect(moveCategory(rows, 3, "down", "zh")).toBeNull();
    expect(moveCategory(rows, 999, "up", "zh")).toBeNull();
    expect(moveCategory([], 1, "up", "zh")).toBeNull();
  });

  it("answers null for a single-row list in either direction", () => {
    const one = [cat(7, 0, "Alfa")];
    expect(moveCategory(one, 7, "up", "zh")).toBeNull();
    expect(moveCategory(one, 7, "down", "zh")).toBeNull();
  });

  it("moves a row past a NEIGHBOUR IT IS TIED WITH", () => {
    // The move that could not work without re-sequencing: three rows sharing one
    // number, ordered by name alone. Pushing Charlie up has to produce numbers,
    // because there is no number here to swap.
    const tied = [cat(1, 0, "Alfa"), cat(2, 0, "Bravo"), cat(3, 0, "Charlie")];
    expect(moveCategory(tied, 3, "up", "zh")).toEqual([
      { id: 1, sort_order: 10 },
      { id: 3, sort_order: 20 },
      { id: 2, sort_order: 30 },
    ]);
  });

  it("survives a round trip: move down, then up, is where it started", () => {
    const down = moveCategory(rows, 1, "down", "zh") ?? [];
    const back = moveCategory(apply(rows, down), 1, "up", "zh");
    expect(back).toEqual(resequence(rows, "zh"));
  });
});

describe("makePortalErpCode", () => {
  it.each([
    ["2026-08-19T10:00:00.000Z", "p1787133600000"],
    ["1970-01-01T00:00:00.000Z", "p0"],
  ])("%s → %s", (iso, expected) => {
    expect(makePortalErpCode(new Date(iso))).toBe(expected);
  });

  it("can never collide with a freepos code", () => {
    // Every ERP code is a decimal id as text ("7", "83" — see CATEGORY_SEED in
    // scripts/seed-categories.ts), so the prefix alone is the guarantee.
    const code = makePortalErpCode(new Date("2026-08-19T10:00:00.000Z"));
    expect(code).toMatch(/^p\d+$/);
    expect(code).not.toMatch(/^\d+$/);
  });

  it("moves with the clock", () => {
    expect(makePortalErpCode(new Date(1))).not.toBe(
      makePortalErpCode(new Date(2)),
    );
  });
});

describe("validateCategoryName", () => {
  const long = "x".repeat(MAX_CATEGORY_NAME_LENGTH + 1);

  it.each([
    // zh only, es only, both — the three shapes the CHECK accepts.
    ["饮料酒水", "", { zh: "饮料酒水" }],
    ["", "Bebidas", { es: "Bebidas" }],
    ["饮料酒水", "Bebidas", { zh: "饮料酒水", es: "Bebidas" }],
    // Trimmed, and a field that was only whitespace is simply absent — storing
    // `{"es": ""}` would draw an EMPTY rail entry for every Spanish caller,
    // because `localizedName` falls back on a MISSING key, not an empty one.
    ["  饮料酒水  ", "   ", { zh: "饮料酒水" }],
    ["\t\n", "  Bebidas ", { es: "Bebidas" }],
  ])("(%s, %s) → %o", (zh, es, expected) => {
    expect(validateCategoryName(zh, es)).toEqual({ ok: true, name: expected });
  });

  it.each([
    ["", ""],
    ["   ", "\t"],
    // Not strings: a crafted POST can send a File or an object, and String()
    // would turn either into a name.
    [null, undefined],
    [{}, []],
    [42, true],
  ])("refuses (%o, %o) as EMPTY_NAME", (zh, es) => {
    expect(validateCategoryName(zh, es)).toEqual({
      ok: false,
      code: "EMPTY_NAME",
    });
  });

  it.each([
    [long, "Bebidas"],
    ["饮料酒水", long],
    [long, long],
  ])("refuses an over-long name", (zh, es) => {
    expect(validateCategoryName(zh, es)).toEqual({
      ok: false,
      code: "NAME_TOO_LONG",
    });
  });

  it("accepts a name exactly at the ceiling", () => {
    const edge = "x".repeat(MAX_CATEGORY_NAME_LENGTH);
    expect(validateCategoryName(edge, "")).toEqual({
      ok: true,
      name: { zh: edge },
    });
  });
});

describe("parseCategoryId", () => {
  it.each([
    ["1", 1],
    ["61", 61],
    [" 7 ", 7],
    ["0", null],
    ["-3", null],
    ["1.5", null],
    ["1e3", null],
    ["", null],
    ["7; drop table", null],
    ["99999999999999999999", null],
    [null, null],
    [{}, null],
  ])("%o → %o", (raw, expected) => {
    expect(parseCategoryId(raw)).toBe(expected);
  });
});

describe("parseMoveDirection", () => {
  it.each([
    ["up", "up"],
    ["down", "down"],
    [" up ", "up"],
    ["UP", null],
    ["", null],
    ["sideways", null],
    [null, null],
  ])("%o → %o", (raw, expected) => {
    expect(parseMoveDirection(raw)).toBe(expected);
  });
});

describe("parseActiveFlag", () => {
  it.each([
    ["1", true],
    ["0", false],
    // Everything else is refused rather than read as "hide": an unrecognised
    // flag must not take a category off every restaurant's rail.
    ["true", null],
    ["", null],
    [null, null],
    [1, null],
  ])("%o → %o", (raw, expected) => {
    expect(parseActiveFlag(raw)).toBe(expected);
  });
});

describe("CATEGORY_ERRORS", () => {
  it("recognises every member and nothing else", () => {
    for (const code of CATEGORY_ERRORS) expect(isCategoryError(code)).toBe(true);
    for (const other of ["ok", "", "DB", "empty_name"]) {
      expect(isCategoryError(other)).toBe(false);
    }
  });
});
