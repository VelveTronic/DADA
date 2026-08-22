import { describe, expect, it } from "vitest";
import {
  CAT_NONE,
  CATEGORY_ERRORS,
  CATEGORY_LIMIT,
  catNeedsCategories,
  compareCategories,
  groupCategories,
  hiddenCategoryIds,
  isCategoryError,
  makePortalErpCode,
  MAX_CATEGORY_NAME_LENGTH,
  moveCategoryInTree,
  parseActiveFlag,
  parseCategoryId,
  parseCategoryOrder,
  parseMoveDirection,
  parseVisibility,
  resequence,
  resolveCatFilter,
  resolveParentLabel,
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

describe("moveCategoryInTree", () => {
  // A row of the tree the moves operate on. Same shape `groupCategories`
  // takes: name + parent_label, parents as zh-only objects.
  function trow(
    id: number,
    sort_order: number,
    zh: string,
    parentZh: string | null = null,
  ) {
    return {
      id,
      sort_order,
      name: { zh },
      parent_label: parentZh === null ? null : { zh: parentZh },
    };
  }

  // The fixture tree, in rail order:
  //   alone1(1) · [grp: g1(2), g2(3)] · alone2(4) · [tail: t1(5), t2(6)]
  const rows = [
    trow(1, 10, "alone1"),
    trow(2, 20, "g1", "grp"),
    trow(3, 30, "g2", "grp"),
    trow(4, 40, "alone2"),
    trow(5, 50, "t1", "tail"),
    trow(6, 60, "t2", "tail"),
  ];

  const idsInOrder = (result: ReturnType<typeof moveCategoryInTree>) => {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    // `steps` numbers strictly by position, so sorting by sort_order IS the
    // flattened display order.
    return [...result.sorts]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => row.id);
  };

  it("moves a whole group past the standalone above it", () => {
    expect(idsInOrder(moveCategoryInTree(rows, { group: "grp" }, "up", "zh")))
      .toEqual([2, 3, 1, 4, 5, 6]);
  });

  it("moves a whole group past the whole group below it", () => {
    const shoulder = [
      trow(1, 10, "a1", "grp"),
      trow(2, 20, "a2", "grp"),
      trow(3, 30, "b1", "tail"),
      trow(4, 40, "b2", "tail"),
    ];
    expect(
      idsInOrder(moveCategoryInTree(shoulder, { group: "grp" }, "down", "zh")),
    ).toEqual([3, 4, 1, 2]);
  });

  it("moves a standalone past a group as ONE step", () => {
    expect(idsInOrder(moveCategoryInTree(rows, { id: 4 }, "up", "zh"))).toEqual(
      [1, 4, 2, 3, 5, 6],
    );
  });

  it("moves a child within its group only", () => {
    expect(idsInOrder(moveCategoryInTree(rows, { id: 3 }, "up", "zh"))).toEqual(
      [1, 3, 2, 4, 5, 6],
    );
  });

  it("a child at its group's end answers EDGE, never escapes the group", () => {
    expect(moveCategoryInTree(rows, { id: 2 }, "up", "zh")).toEqual({
      ok: false,
      code: "EDGE",
    });
    expect(moveCategoryInTree(rows, { id: 3 }, "down", "zh")).toEqual({
      ok: false,
      code: "EDGE",
    });
  });

  it("the list's own ends answer EDGE for groups and standalones alike", () => {
    expect(moveCategoryInTree(rows, { id: 1 }, "up", "zh")).toEqual({
      ok: false,
      code: "EDGE",
    });
    expect(moveCategoryInTree(rows, { group: "tail" }, "down", "zh")).toEqual({
      ok: false,
      code: "EDGE",
    });
  });

  it("answers NOT_FOUND for an id or a group label the list does not hold", () => {
    expect(moveCategoryInTree(rows, { id: 999 }, "up", "zh")).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(moveCategoryInTree(rows, { group: "nope" }, "up", "zh")).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(moveCategoryInTree([], { id: 1 }, "up", "zh")).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("flattens to strict steps, children contiguous behind their group", () => {
    // Scattered legacy numbers: group members interleaved with strangers. One
    // move normalizes the WHOLE list to the tree order, blocks contiguous.
    const scattered = [
      trow(1, 0, "g1", "grp"),
      trow(2, 5, "alone"),
      trow(3, 7, "g2", "grp"),
    ];
    // Tree: [grp: g1, g2] (at g1's position, first) · alone. Move alone up.
    const moved = moveCategoryInTree(scattered, { id: 2 }, "up", "zh");
    if (!moved.ok) throw new Error("expected ok");
    expect(moved.sorts).toEqual([
      { id: 2, sort_order: 10 },
      { id: 1, sort_order: 20 },
      { id: 3, sort_order: 30 },
    ]);
  });

  it("survives a round trip: a group down, then up, is a plain resequence", () => {
    const down = moveCategoryInTree(rows, { group: "grp" }, "down", "zh");
    if (!down.ok) throw new Error("expected ok");
    const back = moveCategoryInTree(
      apply(rows, down.sorts),
      { group: "grp" },
      "up",
      "zh",
    );
    if (!back.ok) throw new Error("expected ok");
    expect(back.sorts).toEqual(resequence(rows, "zh"));
  });

  it("a singleton parent is a standalone: its id moves at top level", () => {
    // One member renders flat (groupCategories' own rule), so its arrows move
    // it among the top-level entries — past real groups included.
    const lone = [
      trow(1, 10, "solo", "solo"),
      trow(2, 20, "g1", "grp"),
      trow(3, 30, "g2", "grp"),
    ];
    expect(
      idsInOrder(moveCategoryInTree(lone, { id: 1 }, "down", "zh")),
    ).toEqual([2, 3, 1]);
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

describe("parseCategoryOrder", () => {
  it("accepts one bounded JSON array of distinct positive bigint-safe ids", () => {
    expect(parseCategoryOrder("[7,2,61]")).toEqual([7, 2, 61]);
  });

  it.each([
    "",
    "not-json",
    "null",
    "{}",
    "[]",
    "[1,1]",
    "[1,null]",
    "[1,0]",
    "[1,-2]",
    "[1,1.5]",
    "[1,9007199254740992]",
  ])("rejects %s", (raw) => {
    expect(parseCategoryOrder(raw)).toBeNull();
  });

  it("rejects a collection beyond the page and RPC safety ceiling", () => {
    expect(
      parseCategoryOrder(
        JSON.stringify(
          Array.from({ length: CATEGORY_LIMIT + 1 }, (_, index) => index + 1),
        ),
      ),
    ).toBeNull();
  });

  it("rejects non-string form parts without coercing them", () => {
    expect(parseCategoryOrder(null)).toBeNull();
    expect(parseCategoryOrder({})).toBeNull();
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

/**
 * The rail as `/staff/productos` reads it for `?cat=`: freepos codes (decimal
 * digit strings), one portal-minted `p<epoch-ms>`, and one hidden category —
 * `is_active` is deliberately NOT part of the resolution, because the filter
 * select offers the hidden ones too.
 */
const CAT_CODES = [
  { id: 2, erp_code: "6" },
  { id: 3, erp_code: "7" },
  { id: 9, erp_code: "83" },
  { id: 12, erp_code: "p1755600000000" },
];

describe("resolveCatFilter", () => {
  it.each([
    // No `?cat=` at all, and the 全部 chip's own value: the whole table.
    ["", null],
    // THE case this function was extracted for. It shipped resolved correctly
    // here and ignored at the query, so the 未分类 view returned every product.
    ["none", { kind: "none" }],
    // A known code, in both flavours the column actually holds.
    ["7", { kind: "id", id: 3 }],
    ["83", { kind: "id", id: 9 }],
    ["p1755600000000", { kind: "id", id: 12 }],
    // Unknown: unfiltered, never an empty table and never a failed query — the
    // customer catalogue's rule for a stale bookmark, applied here.
    ["nope", null],
    ["p123", null],
    ["999", null],
    // Case matters (`erp_code` is a text natural key, not a slug) and so does
    // whitespace: these arrive raw from `searchParams`, untrimmed.
    ["NONE", null],
    [" none ", null],
    ["none ", null],
    [" ", null],
    // A digit string that is not a code, and a would-be injection: both are
    // just words that match no `erp_code`.
    ["0", null],
    ["7 OR 1=1", null],
  ])("%o → %o", (catParam, expected) => {
    expect(resolveCatFilter(catParam, CAT_CODES)).toEqual(expected);
  });

  it("resolves the first `erp_code` that matches, in list order", () => {
    // The column is UNIQUE, so this cannot happen against the real table; the
    // assertion pins the behaviour rather than leaving it to `find`.
    expect(
      resolveCatFilter("7", [
        { id: 3, erp_code: "7" },
        { id: 4, erp_code: "7" },
      ]),
    ).toEqual({ kind: "id", id: 3 });
  });
});

describe("catNeedsCategories", () => {
  it.each([
    ["", false],
    ["none", false],
    ["7", true],
    ["p1755600000000", true],
    ["nope", true],
    [" none ", true],
    ["NONE", true],
  ])("%o → %o", (catParam, expected) => {
    expect(catNeedsCategories(catParam)).toBe(expected);
  });

  /**
   * The contract `/staff/productos` races on, asserted rather than trusted:
   * when the list is not needed, resolving against the EMPTY list gives exactly
   * what resolving against the real one gives. This is what makes the eager
   * `resolveCatFilter(catParam, [])` — the value the raced query is built from
   * — provably the same filter the page later renders under.
   */
  it("means the empty list answers identically", () => {
    for (const catParam of ["", CAT_NONE]) {
      expect(catNeedsCategories(catParam)).toBe(false);
      expect(resolveCatFilter(catParam, [])).toEqual(
        resolveCatFilter(catParam, CAT_CODES),
      );
    }
  });

  it("is the only case where the empty list is safe", () => {
    // The converse, so the predicate cannot quietly widen: every param it calls
    // a lookup really does resolve differently without the list.
    expect(resolveCatFilter("7", [])).toBeNull();
    expect(resolveCatFilter("7", CAT_CODES)).toEqual({ kind: "id", id: 3 });
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

describe("groupCategories", () => {
  function gcat(
    id: number,
    sort_order: number,
    zh: string,
    parentZh: string | null,
  ) {
    return {
      id,
      sort_order,
      name: { zh },
      parent_label: parentZh === null ? null : { zh: parentZh },
    };
  }

  it("rows sharing a parent label become one group, in rail order", () => {
    const rows = [
      gcat(1, 20, "bowls", "tableware"),
      gcat(2, 10, "plates", "tableware"),
      gcat(3, 30, "rice", null),
    ];
    const tree = groupCategories(rows, "zh");
    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({ kind: "group", label: "tableware" });
    const group = tree[0];
    if (group.kind !== "group") throw new Error("expected group");
    expect(group.children.map((c) => c.label)).toEqual(["plates", "bowls"]);
    expect(tree[1]).toMatchObject({ kind: "category" });
  });

  it("a lone member renders flat, not as a heading over one row", () => {
    const rows = [gcat(1, 10, "makro", "makro"), gcat(2, 20, "rice", null)];
    const tree = groupCategories(rows, "zh");
    expect(tree.every((entry) => entry.kind === "category")).toBe(true);
  });

  it("a group includes the row named like the group itself", () => {
    const rows = [
      gcat(1, 10, "supplies", "supplies"),
      gcat(2, 20, "napkins", "supplies"),
    ];
    const tree = groupCategories(rows, "zh");
    expect(tree).toHaveLength(1);
    const group = tree[0];
    if (group.kind !== "group") throw new Error("expected group");
    expect(group.children.map((c) => c.label)).toEqual(["supplies", "napkins"]);
  });

  it("null, empty-object and empty-string parents are all top-level", () => {
    const rows = [
      gcat(1, 10, "a", null),
      { id: 2, sort_order: 20, name: { zh: "b" }, parent_label: {} },
      { id: 3, sort_order: 30, name: { zh: "c" }, parent_label: { zh: "" } },
    ];
    expect(
      groupCategories(rows, "zh").every((entry) => entry.kind === "category"),
    ).toBe(true);
  });

  it("a group sits where its first child would have sat", () => {
    const rows = [
      gcat(1, 10, "aaa", null),
      gcat(2, 20, "ggg", "grp"),
      gcat(3, 40, "hhh", "grp"),
      gcat(4, 30, "mmm", null),
    ];
    const kinds = groupCategories(rows, "zh").map((entry) =>
      entry.kind === "group" ? `group:${entry.label}` : entry.category.label,
    );
    expect(kinds).toEqual(["aaa", "group:grp", "mmm"]);
  });
});

describe("hiddenCategoryIds", () => {
  it.each([
    // [visibility rows, allowed ids, hidden ids owed]
    [[{ id: 1, visibility: "all" }], [], []],
    [[{ id: 1, visibility: "selected" }], [], [1]],
    [[{ id: 1, visibility: "selected" }], [1], []],
    [
      [
        { id: 1, visibility: "selected" },
        { id: 2, visibility: "all" },
        { id: 3, visibility: "selected" },
      ],
      [3],
      [1],
    ],
  ])("case %#", (rows, allowed, owed) => {
    expect(hiddenCategoryIds(rows, new Set(allowed))).toEqual(owed);
  });
});

describe("resolveParentLabel", () => {
  const existing = [
    { zh: "餐厅用品", es: "Menaje" },
    { zh: "冻品" },
    null,
    "not-an-object",
  ];

  it("empty and whitespace-only input clear the parent", () => {
    expect(resolveParentLabel("", existing)).toBeNull();
    expect(resolveParentLabel("   ", existing)).toBeNull();
  });

  it("matching a stored label in EITHER language reuses the stored pair", () => {
    expect(resolveParentLabel("餐厅用品", existing)).toEqual({
      zh: "餐厅用品",
      es: "Menaje",
    });
    expect(resolveParentLabel("Menaje", existing)).toEqual({
      zh: "餐厅用品",
      es: "Menaje",
    });
  });

  it("a stored single-key label comes back single-key, not padded", () => {
    expect(resolveParentLabel("冻品", existing)).toEqual({ zh: "冻品" });
  });

  it("unmatched text becomes a new both-key label, trimmed", () => {
    expect(resolveParentLabel("  海鲜类 ", existing)).toEqual({
      zh: "海鲜类",
      es: "海鲜类",
    });
  });

  it("non-object rows in the existing list are skipped, not crashed on", () => {
    expect(resolveParentLabel("x", [null, 42, "y", []])).toEqual({
      zh: "x",
      es: "x",
    });
  });
});

describe("parseVisibility", () => {
  it.each([
    ["all", "all"],
    ["selected", "selected"],
    ["", null],
    ["ALL", null],
    [null, null],
    [undefined, null],
    [42, null],
  ])("%j → %j", (value, owed) => {
    expect(parseVisibility(value)).toBe(owed);
  });
});
