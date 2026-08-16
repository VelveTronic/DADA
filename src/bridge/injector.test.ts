import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config";
import { AllLinesExcludedError, InjectError } from "./injector";
import {
  DEFAULT_TAX_SLOT,
  MADRID_TODAY_SQL,
  NO_EXPIRY_DATE,
  PEDCLICA_COLUMNS,
  PEDCLICA_INSERT_SQL,
  PEDCLILI_COLUMNS,
  PEDCLILI_INSERT_SQL,
  applyCustomerDefaults,
  buildHeaderParams,
  buildInsertSql,
  buildLineParams,
  buildTaxTables,
  casesForLine,
  computeTaxes,
  contractChecks,
  dedupCheck,
  isoDateFromSql,
  numlinFor,
  prepareOrder,
  reserveCounters,
  roundEuros,
  roundHalfToEven,
  runInjectSteps,
  sqlDateFromIso,
  toNumber,
  toText,
  ultlinFor,
  type PreparedLine,
  type PreparedOrder,
  type SqlParent,
} from "./injector";
import type { ClaimedOrder } from "./payload";

// ---------------------------------------------------------------------------
// The v3.2 reference, transcribed from the sandbox-validated script. These two
// pairs of literals ARE the contract: a reviewer diffs them against
// v32_extract.txt line by line, and the tests below prove the port differs from
// them only where Plan 04 says it must.
// ---------------------------------------------------------------------------

const V32_PEDCLICA_COLUMNS =
  "CAN,EJE,NUMPED,FECPED,FECENT,NUMPEDCLI,CODCLI,IMPBAS1,IMPBAS2,IMPBAS3,IMPBAS4," +
  "IMPBAS5,TPCIVA1,TPCIVA2,TPCIVA3,TPCIVA4,TPCIVA5,IMPIVA1,IMPIVA2,IMPIVA3,IMPIVA4," +
  "IMPIVA5,ESIMPBAS1,ESIMPBAS2,ESIMPBAS3,ESIMPBAS4,TOTPED,NETO,TOTCOS,FORPAG,PRIPAG," +
  "NUMPAG,TIPIVACLI,CALENV,CODPOSENV,calenv2,TIPPOR,COMUNICA,ULTVAL,TARCLI,ULTLIN," +
  "ESTPED,ALBARAN,ACTALB,SERFAC,regiva,IRPFBASTOT,IMPBASIRPF,idventa,USUCREPED,CODUSU," +
  "FECPREVTO,TSENVSRV,TS,fecalt,SEMANA";

/**
 * The v3.2 VALUES list, one expression per entry (an array rather than one
 * comma-joined string because `DATEPART(week,GETDATE())` contains a comma).
 */
const V32_PEDCLICA_VALUES = [
  "@CAN", "@EJE", "@NUMPED", "CAST(GETDATE() AS date)", "CAST(GETDATE() AS date)",
  "@EXT", "@CODCLI", "@B1", "@B2", "@B3", "@B4", "@B5", "@T1", "@T2", "@T3", "@T4",
  "@T5", "@I1", "@I2", "@I3", "@I4", "@I5", "@E1", "@E2", "@E3", "@E4", "@TOT",
  "@NETO", "@TOTCOS", "@FORPAG", "@PRIPAG", "@NUMPAG", "@TIPIVACLI", "@CALENV",
  "@CPENV", "@CAL2", "@TIPPOR", "'0'", "1", "@TARCLI", "@ULTLIN", "'Abierto'", "0",
  "0", "@SERFAC", "@REGIVA", "1", "@NETO", "@IDVENTA", "@USU", "@USU",
  "CAST(GETDATE() AS date)", "GETDATE()", "GETDATE()", "CAST(GETDATE() AS date)",
  "DATEPART(week,GETDATE())",
];

const V32_PEDCLILI_COLUMNS =
  "CAN,EJE,NUMPED,NUMLIN,CODART,CANPED,CANSER,PREVEN,PRECOS,DESMOD,SUBTOT,NETO," +
  "CODALM,TIPIVAART,unidad,UNILOT,CAJ,CODLOT,FECCAD,FECENT,CODCLI,idlinea,COMUNICA";

const V32_PEDCLILI_VALUES = [
  "@CAN", "@EJE", "@NUMPED", "@NUMLIN", "@COD", "@QTY", "@QTY", "@PRE", "@PRECOS",
  "@DES", "@SUB", "@SUB", "@ALM", "@T", "@UNI", "@UNILOT", "@CAJ", "@LOT", "@FCAD",
  "CAST(GETDATE() AS date)", "@CODCLI", "@IDL", "''",
];

/** Plan 04 delta 1: the only header expressions allowed to differ from v3.2. */
const DELTA_1_HEADER: Record<string, string> = {
  FECPED: MADRID_TODAY_SQL,
  FECENT: "@FECENT",
  FECPREVTO: MADRID_TODAY_SQL,
  fecalt: MADRID_TODAY_SQL,
  SEMANA: `DATEPART(week,${MADRID_TODAY_SQL})`,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cfg: BridgeConfig = {
  supabaseUrl: "https://example.supabase.co",
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

function preparedLine(overrides: Partial<PreparedLine> = {}): PreparedLine {
  return {
    codart: "4-007",
    qty: 5,
    prevenEuros: 19.99,
    lineTotalEuros: 99.95,
    lineTotalCents: 9995,
    des: "ARROZ GLUTINOSO 1KG",
    precos: 12.3456,
    tipivaart: "G",
    unilot: 2,
    unidad: "UNIDAD",
    codlot: "VCY111B",
    feccad: new Date(Date.UTC(2027, 4, 1)),
    caj: 2,
    ...overrides,
  };
}

const customer = applyCustomerDefaults({
  TARCLI: 2,
  TIPIVACLI: "N",
  regiva: "R1",
  FORPAG: "CO",
  PRIPAG: 1,
  NUMPAG: 1,
  CALENV: "C/ MAYOR 1",
  CAL2: "PISO 2",
  CODPOSENV: "28001",
  TIPPOR: "Portes Debidos",
});

const taxTables = buildTaxTables(
  [
    { T: "G", POSMAT: 1 },
    { T: "R", POSMAT: 2 },
  ],
  [
    { C: "N", A: "G", TPCIVA: 10 },
    { C: "N", A: "R", TPCIVA: 21 },
  ],
);

function preparedOrder(overrides: Partial<PreparedOrder> = {}): PreparedOrder {
  const lines = overrides.lines ?? [preparedLine()];
  return {
    ref: "PORTAL-4242",
    codcli: 3,
    fecent: new Date(Date.UTC(2026, 7, 20)),
    customer,
    taxes: computeTaxes(lines, customer.tipivacli, taxTables),
    totcosEuros: 61.73,
    lines,
    excludedCodarts: [],
    ...overrides,
  };
}

/**
 * A stand-in for a pool or a transaction that records every statement and every
 * parameter, and replays canned recordsets in order. It is the only way to hold
 * the DB-touching steps to account on a machine that cannot reach SQL Server —
 * and it is what proves no value ever reaches the SQL text.
 */
interface RecordedCall {
  text: string;
  params: Record<string, { type: unknown; value: unknown }>;
}

function fakeParent(responses: Record<string, unknown>[][] = []): {
  parent: SqlParent;
  calls: RecordedCall[];
} {
  const queue = [...responses];
  const calls: RecordedCall[] = [];
  const parent = {
    request() {
      const params: RecordedCall["params"] = {};
      const request = {
        input(name: string, type: unknown, value: unknown) {
          params[name] = { type, value };
          return request;
        },
        query(text: string) {
          calls.push({ text, params });
          const recordset = queue.shift() ?? [];
          return Promise.resolve({
            recordset,
            recordsets: [recordset],
            rowsAffected: [recordset.length],
            output: {},
          });
        },
      };
      return request;
    },
  };
  return { parent: parent as unknown as SqlParent, calls };
}

function claimedOrder(overrides: Partial<ClaimedOrder> = {}): ClaimedOrder {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    order_number: 4242,
    claim_token: "22222222-2222-4222-8222-222222222222",
    delivery_date: "2026-08-20",
    customer_note: null,
    subtotal_cents: 9995,
    codcli: 3,
    tarcli: 2,
    company_name: "Restaurante Prueba",
    items: [
      {
        codart: "4-007",
        qty: 5,
        unit_price_cents: 1999,
        line_total_cents: 9995,
        is_weighed: false,
        is_erp_excluded: false,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Traceability: the two INSERTs against v3.2
// ---------------------------------------------------------------------------

describe("pedclica INSERT vs the v3.2 reference", () => {
  it("writes the same 56 columns in the same order", () => {
    expect(PEDCLICA_COLUMNS.map(([column]) => column).join(",")).toBe(
      V32_PEDCLICA_COLUMNS,
    );
    expect(PEDCLICA_COLUMNS).toHaveLength(V32_PEDCLICA_VALUES.length);
  });

  it("changes exactly the five delta-1 date expressions and nothing else", () => {
    const columns = V32_PEDCLICA_COLUMNS.split(",");
    const changed = columns.filter(
      (_, index) => PEDCLICA_COLUMNS[index][1] !== V32_PEDCLICA_VALUES[index],
    );
    expect(changed).toEqual(["FECPED", "FECENT", "FECPREVTO", "fecalt", "SEMANA"]);

    const expected = V32_PEDCLICA_VALUES.map(
      (value, index) => DELTA_1_HEADER[columns[index]] ?? value,
    );
    expect(PEDCLICA_COLUMNS.map(([, value]) => value)).toEqual(expected);
  });

  it("keeps the audit timestamps on the server clock", () => {
    // TS and TSENVSRV are moments, not business days: delta 1 does not reach them.
    const byColumn = new Map(PEDCLICA_COLUMNS);
    expect(byColumn.get("TS")).toBe("GETDATE()");
    expect(byColumn.get("TSENVSRV")).toBe("GETDATE()");
  });

  it("carries only the two v3.2 literals — no interpolated data", () => {
    const literals = PEDCLICA_INSERT_SQL.match(/'[^']*'/g) ?? [];
    const timezone = literals.filter((value) => value === "'Romance Standard Time'");
    // One per date column delta 1 moved onto the Madrid clock: FECPED,
    // FECPREVTO, fecalt and SEMANA (FECENT became a parameter instead).
    expect(timezone).toHaveLength(4);
    expect(literals.filter((value) => value !== "'Romance Standard Time'")).toEqual([
      "'0'",
      "'Abierto'",
    ]);
  });
});

describe("pedclili INSERT vs the v3.2 reference", () => {
  it("writes the same 23 columns in the same order", () => {
    expect(PEDCLILI_COLUMNS.map(([column]) => column).join(",")).toBe(
      V32_PEDCLILI_COLUMNS,
    );
  });

  it("changes only FECENT, and keeps CANSER bound to CANPED", () => {
    const columns = V32_PEDCLILI_COLUMNS.split(",");
    const changed = columns.filter(
      (_, index) => PEDCLILI_COLUMNS[index][1] !== V32_PEDCLILI_VALUES[index],
    );
    expect(changed).toEqual(["FECENT"]);

    const byColumn = new Map(PEDCLILI_COLUMNS);
    expect(byColumn.get("CANSER")).toBe(byColumn.get("CANPED"));
    expect(byColumn.get("NETO")).toBe(byColumn.get("SUBTOT"));
    expect(byColumn.get("FECENT")).toBe("@FECENT");
  });

  it("carries only the empty COMUNICA literal", () => {
    expect(PEDCLILI_INSERT_SQL.match(/'[^']*'/g)).toEqual(["''"]);
  });
});

describe("buildInsertSql", () => {
  it("pairs each column with its value expression", () => {
    expect(
      buildInsertSql("t", [
        ["a", "@a"],
        ["b", "1"],
      ]),
    ).toBe("INSERT INTO t (a,b) VALUES (@a,1)");
  });
});

// ---------------------------------------------------------------------------
// Parameter builders
// ---------------------------------------------------------------------------

function placeholders(text: string): string[] {
  const found = text.match(/@[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(found.map((token) => token.slice(1)))].sort();
}

describe("buildHeaderParams", () => {
  const taxes = computeTaxes([preparedLine()], "N", taxTables);
  const params = buildHeaderParams({
    can: "B",
    eje: 26,
    numped: 501,
    ref: "PORTAL-4242",
    codcli: 3,
    fecent: new Date(Date.UTC(2026, 7, 20)),
    taxes,
    totcosEuros: 61.73,
    customer,
    ultlin: 5,
    serfac: 1,
    idventa: 900123,
    erpUser: "SFY",
  });

  it("supplies exactly the placeholders the statement uses", () => {
    expect(Object.keys(params).sort()).toEqual(placeholders(PEDCLICA_INSERT_SQL));
  });

  it("stamps all five TPCIVA slots and only four ESIMPBAS flags", () => {
    expect(["T1", "T2", "T3", "T4", "T5"].every((key) => key in params)).toBe(true);
    expect(["E1", "E2", "E3", "E4"].every((key) => key in params)).toBe(true);
    expect("E5" in params).toBe(false);
  });

  it("converts money to euros and flags the slots that carry a base", () => {
    // The one line is 99.95 at tax type G, which tipivaar puts in slot 1.
    expect(params.B1.value).toBe(99.95);
    expect(params.T1.value).toBe(10);
    expect(params.I1.value).toBe(10);
    expect(params.E1.value).toBe(1);
    expect(params.B2.value).toBe(0);
    expect(params.E2.value).toBe(0);
    expect(params.NETO.value).toBe(99.95);
    expect(params.TOT.value).toBe(109.95);
  });

  it("carries the customer's commercial fields through untouched", () => {
    expect(params.FORPAG.value).toBe("CO");
    expect(params.TIPIVACLI.value).toBe("N");
    expect(params.CPENV.value).toBe("28001");
    expect(params.CAL2.value).toBe("PISO 2");
    expect(params.TARCLI.value).toBe(2);
    expect(params.USU.value).toBe("SFY");
  });
});

describe("buildLineParams", () => {
  const params = buildLineParams({
    can: "B",
    eje: 26,
    numped: 501,
    numlin: 5,
    codcli: 3,
    alm: "00001",
    fecent: new Date(Date.UTC(2026, 7, 20)),
    idlinea: 700100,
    line: preparedLine(),
  });

  it("supplies exactly the placeholders the statement uses", () => {
    expect(Object.keys(params).sort()).toEqual(placeholders(PEDCLILI_INSERT_SQL));
  });

  it("uses the PORTAL price, not an ERP price", () => {
    expect(params.PRE.value).toBe(19.99);
    expect(params.SUB.value).toBe(99.95);
  });

  it("carries the lot and its expiry", () => {
    expect(params.LOT.value).toBe("VCY111B");
    expect(params.FCAD.value).toEqual(new Date(Date.UTC(2027, 4, 1)));
    expect(params.CAJ.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

describe("roundHalfToEven", () => {
  it("matches .NET's [math]::Round at midpoints", () => {
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(3.5)).toBe(4);
    expect(roundHalfToEven(0.5)).toBe(0);
    expect(roundHalfToEven(1.5)).toBe(2);
    expect(roundHalfToEven(-2.5)).toBe(-2);
    expect(roundHalfToEven(-3.5)).toBe(-4);
  });

  it("rounds normally away from midpoints", () => {
    expect(roundHalfToEven(2.4)).toBe(2);
    expect(roundHalfToEven(2.6)).toBe(3);
    expect(roundHalfToEven(-2.4)).toBe(-2);
    expect(roundHalfToEven(-2.6)).toBe(-3);
    expect(roundHalfToEven(7)).toBe(7);
  });
});

describe("roundEuros", () => {
  it("rounds a float euro sum to cents", () => {
    expect(roundEuros(61.728)).toBe(61.73);
    expect(roundEuros(0.1 + 0.2)).toBe(0.3);
  });
});

describe("casesForLine", () => {
  it("divides the quantity by the case size", () => {
    expect(casesForLine(12, 6)).toBe(2);
    expect(casesForLine(13, 6)).toBe(2);
    expect(casesForLine(14, 6)).toBe(2);
    expect(casesForLine(16, 6)).toBe(3);
    expect(casesForLine(18, 6)).toBe(3);
  });

  it("rounds an exact half to even, as [int][math]::Round does", () => {
    // 5 units at 2 per case is exactly 2.5 cases; v3.2 writes 2, not 3.
    expect(casesForLine(5, 2)).toBe(2);
    expect(casesForLine(7, 2)).toBe(4);
    // 15 at 6 per case is 2.5 as well.
    expect(casesForLine(15, 6)).toBe(2);
    expect(casesForLine(21, 6)).toBe(4);
  });

  it("is 0 when the article is not sold by the case", () => {
    expect(casesForLine(5, 0)).toBe(0);
    expect(casesForLine(5, -1)).toBe(0);
    expect(casesForLine(5, Number.NaN)).toBe(0);
  });
});

describe("numlinFor / ultlinFor", () => {
  it("numbers lines in fives and reports the last one", () => {
    expect([0, 1, 2].map(numlinFor)).toEqual([5, 10, 15]);
    expect(ultlinFor(3)).toBe(15);
    expect(ultlinFor(1)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tax slots
// ---------------------------------------------------------------------------

describe("computeTaxes", () => {
  it("sums bases per slot and applies the customer's rate", () => {
    const totals = computeTaxes(
      [
        { lineTotalCents: 10_000, tipivaart: "G" },
        { lineTotalCents: 5_000, tipivaart: "R" },
        { lineTotalCents: 2_500, tipivaart: "G" },
      ],
      "N",
      taxTables,
    );
    expect(totals.baseCents[1]).toBe(12_500);
    expect(totals.baseCents[2]).toBe(5_000);
    expect(totals.ratePct[1]).toBe(10);
    expect(totals.ratePct[2]).toBe(21);
    expect(totals.ivaCents[1]).toBe(1_250);
    expect(totals.ivaCents[2]).toBe(1_050);
    expect(totals.netoCents).toBe(17_500);
    expect(totals.ivaTotalCents).toBe(2_300);
    expect(totals.totalCents).toBe(19_800);
  });

  it("falls back to slot 3 for an unmapped or unassigned article tax type", () => {
    const tables = buildTaxTables(
      [
        { T: "G", POSMAT: 1 },
        { T: "Z", POSMAT: 0 },
      ],
      [{ C: "N", A: "G", TPCIVA: 10 }],
    );
    const totals = computeTaxes(
      [
        { lineTotalCents: 1_000, tipivaart: "Z" },
        { lineTotalCents: 2_000, tipivaart: "UNKNOWN" },
      ],
      "N",
      tables,
    );
    expect(DEFAULT_TAX_SLOT).toBe(3);
    expect(totals.baseCents[3]).toBe(3_000);
    // No article type owns slot 3 here, so there is no rate to apply.
    expect(totals.ratePct[3]).toBe(0);
    expect(totals.ivaCents[3]).toBe(0);
    expect(totals.netoCents).toBe(3_000);
  });

  it("uses 0% when the customer has no iva row for that article type", () => {
    const totals = computeTaxes([{ lineTotalCents: 1_000, tipivaart: "G" }], "X", taxTables);
    expect(totals.ratePct[1]).toBe(0);
    expect(totals.ivaCents[1]).toBe(0);
    expect(totals.totalCents).toBe(1_000);
  });

  it("refuses a POSMAT with no header column instead of losing the base", () => {
    // v3.2 would have added a sixth hashtable key nothing reads, quietly
    // dropping this line's base out of NETO while leaving the line on the pedido.
    const tables = buildTaxTables([{ T: "G", POSMAT: 6 }], []);
    expect(() => computeTaxes([{ lineTotalCents: 100, tipivaart: "G" }], "N", tables)).toThrow(
      /POSMAT/,
    );
  });

  it("rounds IVA half to even, as the reference does", () => {
    // 0.25 at 10% is exactly 0.025 — a true midpoint.
    const tables = buildTaxTables([{ T: "G", POSMAT: 1 }], [{ C: "N", A: "G", TPCIVA: 10 }]);
    expect(computeTaxes([{ lineTotalCents: 25, tipivaart: "G" }], "N", tables).ivaCents[1]).toBe(2);
    expect(computeTaxes([{ lineTotalCents: 15, tipivaart: "G" }], "N", tables).ivaCents[1]).toBe(2);
  });
});

describe("buildTaxTables", () => {
  it("inverts POSMAT deterministically when two types share a slot", () => {
    // The query is ORDER BY TIPIVAART, so "last wins" is stable.
    const tables = buildTaxTables(
      [
        { T: "A", POSMAT: 1 },
        { T: "B", POSMAT: 1 },
      ],
      [],
    );
    expect(tables.articleTypeBySlot.get(1)).toBe("B");
    expect(tables.slotByArticleType.get("A")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Customer defaults
// ---------------------------------------------------------------------------

describe("applyCustomerDefaults", () => {
  const blank = {
    TARCLI: null,
    TIPIVACLI: null,
    regiva: null,
    FORPAG: null,
    PRIPAG: null,
    NUMPAG: null,
    CALENV: null,
    CAL2: null,
    CODPOSENV: null,
    TIPPOR: null,
  };

  it("applies the v3.2 fallbacks for the columns Wingest leaves blank", () => {
    expect(applyCustomerDefaults(blank)).toEqual({
      tarcli: 0,
      tipivacli: "",
      regiva: "R1",
      forpag: "CO",
      pripag: 1,
      numpag: 1,
      calenv: "",
      cal2: "",
      cpenv: "",
      tippor: "Portes Debidos",
    });
  });

  it("treats a zero or negative payment term as unset", () => {
    expect(applyCustomerDefaults({ ...blank, PRIPAG: 0, NUMPAG: -2 }).pripag).toBe(1);
    expect(applyCustomerDefaults({ ...blank, PRIPAG: 0, NUMPAG: -2 }).numpag).toBe(1);
  });

  it("keeps the customer's own values when the ERP has them", () => {
    expect(
      applyCustomerDefaults({ ...blank, regiva: "R2", FORPAG: "T30", PRIPAG: 30, NUMPAG: 2 }),
    ).toMatchObject({ regiva: "R2", forpag: "T30", pripag: 30, numpag: 2 });
  });

  it("trims the char columns the ERP pads", () => {
    expect(applyCustomerDefaults({ ...blank, TIPIVACLI: "N   " }).tipivacli).toBe("N");
  });
});

// ---------------------------------------------------------------------------
// Driver-boundary coercion
// ---------------------------------------------------------------------------

describe("toNumber", () => {
  it("accepts the STRING tedious returns for a bigint column", () => {
    // idventa / idlinea / newcontador.NUMERO arrive this way.
    const parsed = toNumber("900123");
    expect(parsed).toBe(900123);
    // The arithmetic is the point: `"900123" + 1` would have been "9001231".
    expect((parsed ?? 0) + 1).toBe(900124);
  });

  it("accepts numbers and bigints", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is null for anything that is not a number", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });
});

describe("toText", () => {
  it("trims and turns NULL into an empty string", () => {
    expect(toText("  B  ")).toBe("B");
    expect(toText(null)).toBe("");
    expect(toText(undefined)).toBe("");
  });
});

describe("date conversion across the SQL boundary", () => {
  it("reads a driver Date as its UTC calendar day", () => {
    expect(isoDateFromSql(new Date(Date.UTC(2026, 7, 16)))).toBe("2026-08-16");
    expect(isoDateFromSql(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01");
  });

  it("accepts a string date without reinterpreting it", () => {
    expect(isoDateFromSql("2026-08-16T00:00:00.000Z")).toBe("2026-08-16");
  });

  it("refuses anything else rather than guessing", () => {
    expect(() => isoDateFromSql(null)).toThrow();
    expect(() => isoDateFromSql(new Date("nope"))).toThrow();
  });

  it("round-trips an ISO date to midnight UTC and back", () => {
    const date = sqlDateFromIso("2026-08-20");
    expect(date.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(isoDateFromSql(date)).toBe("2026-08-20");
  });

  it("uses 1900-01-01 for a line with no lot", () => {
    expect(isoDateFromSql(NO_EXPIRY_DATE)).toBe("1900-01-01");
  });
});

// ---------------------------------------------------------------------------
// DB-touching steps, driven by the recording fake
// ---------------------------------------------------------------------------

describe("dedupCheck", () => {
  it("looks in both pedclica and pedclicah, with the ref as a parameter", async () => {
    const { parent, calls } = fakeParent([[{ NUMPED: 501 }]]);
    expect(await dedupCheck(parent, cfg, "PORTAL-4242")).toBe(501);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("FROM pedclica ");
    expect(calls[0].text).toContain("FROM pedclicah ");
    expect(calls[0].text).not.toContain("PORTAL-4242");
    expect(calls[0].params.ext.value).toBe("PORTAL-4242");
    expect(calls[0].params.can.value).toBe("B");
  });

  it("is null when the portal ref has never been injected", async () => {
    const { parent } = fakeParent([[]]);
    expect(await dedupCheck(parent, cfg, "PORTAL-4242")).toBeNull();
  });
});

describe("reserveCounters", () => {
  it("takes NUMPED from the counter and the global ids from GREATEST(counter, max+1)", async () => {
    const { parent, calls } = fakeParent([
      [{ NUMERO: 501 }], // OUTPUT deleted.NUMERO
      [{ NUMERO: "900000" }], // ZZ/99 IDVENTA counter, as a bigint string
      [{ "": "900123" }], // MAX(idventa) across pedclica + albfacca
      [], // UPDATE IDVENTA
      [{ NUMERO: "700000" }], // ZZ/99 IDPEDCLILI counter
      [{ "": "700099" }], // MAX(idlinea) across pedclili + albfacli
      [], // UPDATE IDPEDCLILI
    ]);

    expect(await reserveCounters(parent, cfg, 3)).toEqual({
      numped: 501,
      idventa: 900_124,
      lineBase: 700_100,
    });

    // The counters are written forward past everything this order reserved.
    const updates = calls.filter((call) => call.text.startsWith("UPDATE newcontador SET NUMERO=@next"));
    expect(updates.map((call) => call.params.next.value)).toEqual([900_125, 700_103]);
  });

  it("prefers the counter when it is already ahead of the data", async () => {
    const { parent } = fakeParent([
      [{ NUMERO: 501 }],
      [{ NUMERO: 999_999 }],
      [{ "": 900_123 }],
      [],
      [{ NUMERO: 800_000 }],
      [{ "": 700_099 }],
      [],
    ]);
    const counters = await reserveCounters(parent, cfg, 1);
    expect(counters.idventa).toBe(999_999);
    expect(counters.lineBase).toBe(800_000);
  });

  it("refuses to build a pedido numbered zero when the counter row is missing", async () => {
    const { parent } = fakeParent([[]]);
    await expect(reserveCounters(parent, cfg, 1)).rejects.toThrow(/NUMPEDCLI counter/);
  });
});

describe("contractChecks", () => {
  const ok = [[{ "": 1 }], [{ "": 2 }], [{ "": 1 }], [{ "": 1 }]];

  it("passes when the header, both lines, the user and the adi row all check out", async () => {
    const { parent, calls } = fakeParent(ok);
    await expect(contractChecks(parent, cfg, 501, 3, 2)).resolves.toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(calls[0].text).toContain("CONVERT(time,FECPED)='00:00:00'");
    expect(calls[0].text).toContain("RTRIM(ESTPED)='Abierto'");
    expect(calls[0].text).toContain("ALBARAN=0");
    expect(calls[1].text).toContain("CANSER=CANPED");
    expect(calls[2].text).toContain("FROM susuario");
    expect(calls[3].text).toContain("FROM pedclica_adi");
  });

  it("fails when the header is not exactly one midnight-dated open row", async () => {
    const { parent } = fakeParent([[{ "": 0 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, 2)).rejects.toThrow(/CONTRATO: cabecera/);
  });

  it("fails when a line is not servible", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 1 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, 2)).rejects.toThrow(
      /CONTRATO: lineas servibles 1 de 2/,
    );
  });

  it("fails when the ERP user does not exist", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 2 }], [{ "": 0 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, 2)).rejects.toThrow(/usuario SFY no existe/);
  });

  it("fails when pedclica_adi is not exactly one row", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 2 }], [{ "": 1 }], [{ "": 0 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, 2)).rejects.toThrow(/pedclica_adi/);
  });
});

describe("runInjectSteps", () => {
  it("recovers the existing NUMPED without writing anything", async () => {
    const { parent, calls } = fakeParent([[{ NUMPED: 777 }]]);
    expect(await runInjectSteps(parent, cfg, preparedOrder())).toEqual({
      numped: 777,
      recovered: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.text.startsWith("INSERT"))).toBe(false);
  });

  it("writes header, adi and one line per prepared line, then checks the contract", async () => {
    const lines = [preparedLine(), preparedLine({ codart: "5-051", tipivaart: "R" })];
    const { parent, calls } = fakeParent([
      [], // dedup: no hit
      [{ NUMERO: 501 }],
      [{ NUMERO: "900000" }],
      [{ "": "900123" }],
      [],
      [{ NUMERO: "700000" }],
      [{ "": "700099" }],
      [],
      [], // INSERT pedclica
      [], // INSERT pedclica_adi
      [], // INSERT pedclili x2
      [],
      [{ "": 1 }], // contract: cabecera
      [{ "": 2 }], // contract: lineas
      [{ "": 1 }], // contract: usuario
      [{ "": 1 }], // contract: adi
    ]);

    expect(await runInjectSteps(parent, cfg, preparedOrder({ lines }))).toEqual({
      numped: 501,
      recovered: false,
    });

    const inserts = calls.filter((call) => call.text.startsWith("INSERT"));
    expect(inserts.map((call) => call.text.slice(0, 24))).toEqual([
      "INSERT INTO pedclica (CA",
      "INSERT INTO pedclica_adi",
      "INSERT INTO pedclili (CA",
      "INSERT INTO pedclili (CA",
    ]);

    const [header, , first, second] = inserts;
    expect(header.params.NUMPED.value).toBe(501);
    expect(header.params.EXT.value).toBe("PORTAL-4242");
    expect(header.params.IDVENTA.value).toBe(900_124);
    expect(header.params.ULTLIN.value).toBe(10);
    // Two lines, two tax slots: 99.95 at G (slot 1) and 99.95 at R (slot 2).
    expect(header.params.B1.value).toBe(99.95);
    expect(header.params.B2.value).toBe(99.95);
    expect(header.params.NETO.value).toBe(199.9);

    expect(first.params.NUMLIN.value).toBe(5);
    expect(second.params.NUMLIN.value).toBe(10);
    expect(first.params.IDL.value).toBe(700_100);
    expect(second.params.IDL.value).toBe(700_101);
    expect(second.params.COD.value).toBe("5-051");
  });

  it("never puts a value into the SQL text", async () => {
    const lines = [preparedLine()];
    const { parent, calls } = fakeParent([
      [],
      [{ NUMERO: 501 }],
      [{ NUMERO: 900_000 }],
      [{ "": 900_123 }],
      [],
      [{ NUMERO: 700_000 }],
      [{ "": 700_099 }],
      [],
      [],
      [],
      [],
      [{ "": 1 }],
      [{ "": 1 }],
      [{ "": 1 }],
      [{ "": 1 }],
    ]);
    await runInjectSteps(parent, cfg, preparedOrder({ lines }));

    const everySql = calls.map((call) => call.text).join("\n");
    for (const value of [
      "PORTAL-4242",
      "4-007",
      "VCY111B",
      "ARROZ GLUTINOSO 1KG",
      "19.99",
      "99.95",
      "900124",
      "700100",
      "00001",
    ]) {
      expect(everySql).not.toContain(value);
    }
  });
});

describe("prepareOrder", () => {
  it("refuses an all-excluded order before touching the database", async () => {
    const { parent, calls } = fakeParent();
    const order = claimedOrder({
      items: [
        {
          codart: "4-007",
          qty: 1,
          unit_price_cents: 100,
          line_total_cents: 100,
          is_weighed: false,
          is_erp_excluded: true,
        },
      ],
    });
    await expect(prepareOrder(parent, cfg, order)).rejects.toBeInstanceOf(
      AllLinesExcludedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("names the order on the error, so the log line is actionable", async () => {
    const { parent } = fakeParent();
    const order = claimedOrder({ items: [] });
    const error = await prepareOrder(parent, cfg, order).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InjectError);
    const injectError = error as InjectError;
    expect(injectError.code).toBe("ALL_LINES_EXCLUDED");
    expect(injectError.orderNumber).toBe(4242);
    expect(injectError.ref).toBe("PORTAL-4242");
    expect(injectError.message).toContain("PORTAL-4242");
  });

  it("resolves dates, customer, taxes and lots into one prepared order", async () => {
    const { parent, calls } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }], // Madrid today
      [
        {
          TARCLI: 2,
          TIPIVACLI: "N",
          regiva: "R1",
          FORPAG: "CO",
          PRIPAG: 1,
          NUMPAG: 1,
          CALENV: "C/ MAYOR 1",
          CAL2: "",
          CODPOSENV: "28001",
          TIPPOR: "",
        },
      ],
      [{ T: "G", POSMAT: 1 }], // tipivaar
      [{ C: "N", A: "G", TPCIVA: 10 }], // iva
      [{ DES: "ARROZ", PRECOS: 12.3456, T: "G", UNILOT: 2, UNI: "UNIDAD" }], // articulo
      [{ LOT: "VCY111B", FECCAD: new Date(Date.UTC(2027, 4, 1)) }], // stolot
    ]);

    const prepared = await prepareOrder(parent, cfg, claimedOrder());

    expect(prepared.ref).toBe("PORTAL-4242");
    expect(prepared.fecent.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(prepared.customer.tippor).toBe("Portes Debidos");
    expect(prepared.taxes.netoCents).toBe(9995);
    expect(prepared.taxes.ivaCents[1]).toBe(1000);
    expect(prepared.totcosEuros).toBe(61.73);
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0]).toMatchObject({
      codart: "4-007",
      prevenEuros: 19.99,
      lineTotalEuros: 99.95,
      codlot: "VCY111B",
      caj: 2,
    });
    // The Madrid date is read from SQL Server, never from this process's clock.
    expect(calls[0].text).toBe(`SELECT ${MADRID_TODAY_SQL}`);
  });

  it("pulls a stale delivery date forward to Madrid today", async () => {
    const { parent } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 0, NUMPAG: 0, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 0, UNI: "KG" }],
      [],
    ]);
    const prepared = await prepareOrder(
      parent,
      cfg,
      claimedOrder({ delivery_date: "2026-08-01" }),
    );
    expect(prepared.fecent.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    // No lot found: v3.2's empty CODLOT and 1900-01-01 FECCAD.
    expect(prepared.lines[0].codlot).toBe("");
    expect(prepared.lines[0].feccad).toEqual(NO_EXPIRY_DATE);
    expect(prepared.lines[0].caj).toBe(0);
  });

  it("refuses to ship a pedido short a line the ERP does not know", async () => {
    const { parent } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [], // articulo: no such CODART
    ]);
    await expect(prepareOrder(parent, cfg, claimedOrder())).rejects.toThrow(
      /articulo has no CODART/,
    );
  });

  it("keeps excluded lines off the pedido but reports them", async () => {
    const { parent } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD" }],
      [{ LOT: "L1", FECCAD: new Date(Date.UTC(2027, 0, 1)) }],
    ]);
    const order = claimedOrder({
      subtotal_cents: 19_995,
      items: [
        ...claimedOrder().items,
        {
          codart: "SERVICIO-1",
          qty: 1,
          unit_price_cents: 10_000,
          line_total_cents: 10_000,
          is_weighed: false,
          is_erp_excluded: true,
        },
      ],
    });
    const prepared = await prepareOrder(parent, cfg, order);
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.excludedCodarts).toEqual(["SERVICIO-1"]);
    // Header totals recompute from the INCLUDED lines only (delta 4), so NETO is
    // the order's 199.95 subtotal minus the 100.00 that staff will handle.
    expect(prepared.taxes.netoCents).toBe(9995);
  });
});
