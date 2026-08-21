import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config";
import { AllLinesExcludedError, InjectError } from "./injector";
import {
  DEFAULT_TAX_SLOT,
  ERP_COMMIT_OUTCOME_UNKNOWN,
  ERP_NUMPED_COUNTER_INVALID,
  ERP_PEDIDO_IDENTITY_INVALID,
  ERP_PEDIDO_RECOVERY_MISMATCH,
  ERP_ROLLBACK_FAILED,
  LOT_AVAILABLE_SQL,
  LOT_FRESH_SQL,
  LOT_ORDER_SQL,
  LOT_PICK_SQL,
  LOT_TIER_SQL,
  MADRID_TODAY_SQL,
  NO_EXPIRY_DATE,
  PEDCLICA_COLUMNS,
  PEDCLICA_INSERT_SQL,
  PEDCLILI_COLUMNS,
  PEDCLILI_INSERT_SQL,
  applyCustomerDefaults,
  baseUnitsForLine,
  buildHeaderParams,
  buildInsertSql,
  buildLineParams,
  buildTaxTables,
  computeTaxes,
  commitTransactionOrAbort,
  contractChecks,
  dedupCheck,
  isoDateFromSql,
  lineSubtotalCents,
  lotFlagsFor,
  numlinFor,
  pickLot,
  preflightOrder,
  prepareOrder,
  reserveCounters,
  rollbackTransactionOrAbort,
  roundEuros,
  roundHalfToEven,
  runInjectSteps,
  sqlDateFromIso,
  toNumber,
  toText,
  ultlinFor,
  type PreparedLine,
  type PreparedOrder,
  type ErpPedidoRecoveryExpectation,
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

/**
 * v3.2's two lot queries — and the ONE place this port deliberately no longer
 * matches the reference.
 *
 * DEVIATION, owner's decision of **2026-08-16**, taken after the sandbox E2E
 * rather than from Plan 04, so a future reader does not read the difference
 * below as drift: v3.2 filtered and ordered on the raw `stolot.CANT`, but
 * Wingest's pedido→albarán conversion checks `CANT` minus what every still-OPEN
 * pedido has outstanding on that lot (`CANPED-CANSER`). The E2E proved it — lot
 * 4851351437 in almacén 00001 held `CANT=+24` while open pedido `NUMPED` 11 held
 * `CANPED=48`/`CANSER=0` on it, so Wingest answered "Disponible: -24" (24−48)
 * and refused the conversion; it passed only once CANT reached 124 (124−48=76).
 * A pedido picked on raw CANT is therefore one a human has to clear a dialog
 * for, and the injector picks on REAL availability instead.
 *
 * These two literals stay here as what a reviewer diffs against; the tests below
 * state exactly what replaced them and pin the new shape.
 */
const V32_LOT_COVERING_SQL =
  "SELECT TOP 1 RTRIM(CODLOT) AS LOT, FECCAD FROM stolot" +
  " WHERE CODALM=@alm AND RTRIM(CODART)=@codart" +
  " AND (FECCAD>GETDATE() OR FECCAD<'19010101') AND VENDIBLE=1 AND CANT>=@qty" +
  " ORDER BY FECCAD ASC";

const V32_LOT_FALLBACK_SQL =
  "SELECT TOP 1 RTRIM(CODLOT) AS LOT, FECCAD FROM stolot" +
  " WHERE CODALM=@alm AND RTRIM(CODART)=@codart" +
  " AND (FECCAD>GETDATE() OR FECCAD<'19010101') AND VENDIBLE=1 AND CANT>0" +
  " ORDER BY CANT DESC";

/**
 * And what this port emits INSTEAD, spelled out byte for byte rather than
 * imported — the same pinning the two INSERTs get above, for the same reason: a
 * change to the statement has to be made here too, in front of a reviewer, and
 * cannot pass as a refactor.
 *
 * Read against the v3.2 pair above, the differences are the whole deviation:
 * raw `CANT` became `CANT` minus the open pedidos' outstanding quantity, and the
 * fallback sorts by that instead of by what is on the shelf. The three
 * `COLLATE DATABASE_DEFAULT` labels are what makes that subquery compile at all
 * across Wingest's mixed collations — see the test that pins them.
 */
const LOT_RESERVATION_SQL =
  "(s.CANT - ISNULL((SELECT SUM(ISNULL(l.CANPED,0) - ISNULL(l.CANSER,0)) FROM pedclili l" +
  " JOIN pedclica c ON c.CAN=l.CAN AND c.EJE=l.EJE AND c.NUMPED=l.NUMPED" +
  " WHERE c.ESTPED='Abierto' AND l.CODALM=s.CODALM COLLATE DATABASE_DEFAULT" +
  " AND l.CODART=s.CODART COLLATE DATABASE_DEFAULT" +
  " AND l.CODLOT=s.CODLOT COLLATE DATABASE_DEFAULT), 0))";

const EXPECTED_LOT_FRESH_SQL = "(s.FECCAD>GETDATE() OR s.FECCAD<'19010101')";

const EXPECTED_LOT_TIER_SQL =
  "CASE WHEN f.FRESCO=1 AND a.DISPO>=@qty THEN 1 WHEN f.FRESCO=1 THEN 2" +
  " WHEN a.DISPO>=@qty THEN 3 ELSE 4 END";

const EXPECTED_LOT_ORDER_SQL =
  "ORDER BY t.TIER ASC, CASE WHEN t.TIER=1 THEN s.FECCAD END ASC," +
  " CASE WHEN t.TIER>=3 THEN s.FECCAD END DESC, a.DISPO DESC, RTRIM(s.CODLOT) ASC";

/**
 * The 2026-08-21 ladder, in one statement where v3.2 had two queries and this
 * port briefly had two of its own. Spelled out here for the same reason the
 * pair above was: a change to the statement has to be made in front of a
 * reviewer and cannot pass as a refactor.
 */
const EXPECTED_LOT_PICK_SQL =
  "SELECT TOP 1 t.TIER, RTRIM(s.CODLOT) AS LOT, s.FECCAD, a.DISPO," +
  " DATEDIFF(day,s.FECCAD,GETDATE()) AS DIASCAD" +
  " FROM stolot s" +
  ` CROSS APPLY (VALUES (${LOT_RESERVATION_SQL})) AS a(DISPO)` +
  ` CROSS APPLY (VALUES (CASE WHEN ${EXPECTED_LOT_FRESH_SQL} THEN 1 ELSE 0 END)) AS f(FRESCO)` +
  ` CROSS APPLY (VALUES (${EXPECTED_LOT_TIER_SQL})) AS t(TIER)` +
  " WHERE s.CODALM=@alm AND RTRIM(s.CODART)=@codart AND s.VENDIBLE=1" +
  " AND s.FECCAD IS NOT NULL AND a.DISPO>0 " +
  EXPECTED_LOT_ORDER_SQL;

/** Plan 04 delta 1: the only header expressions allowed to differ from v3.2. */
const DELTA_1_HEADER: Record<string, string> = {
  FECPED: "@FECPED",
  FECENT: "@FECENT",
  FECPREVTO: "@FECPED",
  fecalt: "@FECPED",
  SEMANA: "DATEPART(week,@FECPED)",
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
  allowHistoricalEje: false,
  historicalOrderId: null,
  alm: "00001",
  // The shipped defaults: the expired rungs are computed and counted, never
  // written. The gate tests below override this pair explicitly.
  lotAllowExpired: false,
  lotExpiredMaxDays: 0,
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
};

/**
 * A factor-1 line: 5 cajas that hold one unit each, which is what 2,172 of the
 * 2,971 products in the catalogue are. `qtyBase` equals `qty` here, so the tax
 * and header arithmetic below reads in plain euros.
 */
function preparedLine(overrides: Partial<PreparedLine> = {}): PreparedLine {
  return {
    codart: "4-007",
    qty: 5,
    isWeighed: false,
    qtyBase: 5,
    unitPriceCents: 1999,
    prevenEuros: 19.99,
    lineTotalEuros: 99.95,
    lineTotalCents: 9995,
    portalLineTotalCents: 9995,
    des: "ARROZ GLUTINOSO 1KG",
    precos: 12.3456,
    tipivaart: "G",
    unilot: 1,
    unidad: "UNIDAD",
    codlot: "VCY111B",
    feccad: new Date(Date.UTC(2027, 4, 1)),
    // The ideal pick, so `lotFlagsFor` says nothing about a default line.
    lotTier: "fresh_covering",
    lotOutcome: "lot_used",
    lotDispo: 80,
    lotDiasCad: null,
    ...overrides,
  };
}

/**
 * The worked example the runbook now carries: 2 cajas of 1-001, 24 bottles per
 * caja at 0.96 € each. The portal shows 23.04 €/caja and charges 46.08 €; the
 * pedido must read CANPED=CANSER=48, CAJ=2, PREVEN=0.96, SUBTOT=46.08.
 */
function cajaLine(overrides: Partial<PreparedLine> = {}): PreparedLine {
  return preparedLine({
    codart: "1-001",
    qty: 2,
    qtyBase: 48,
    unitPriceCents: 96,
    prevenEuros: 0.96,
    lineTotalEuros: 46.08,
    lineTotalCents: 4608,
    portalLineTotalCents: 4608,
    unilot: 24,
    ...overrides,
  });
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
    fecped: new Date(Date.UTC(2026, 7, 16)),
    fecent: new Date(Date.UTC(2026, 7, 20)),
    customer,
    taxes: computeTaxes(lines, customer.tipivacli, taxTables),
    totcosEuros: 61.73,
    lines,
    excludedCodarts: [],
    lotFlags: [],
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
        units_per_case: 1,
        unit_price_cents: 1999,
        line_total_cents: 9995,
        is_weighed: false,
        is_erp_excluded: false,
      },
    ],
    ...overrides,
  };
}

describe("uncertain ERP transaction outcomes", () => {
  const context = {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderNumber: 4242,
    ref: "PORTAL-4242",
  };

  it("makes every rejected commit retryable, batch-aborting and outcome-unknown", async () => {
    const commitCause = new Error("socket closed during COMMIT");
    let rollbackCalls = 0;
    const transaction = {
      commit: () => Promise.reject(commitCause),
      rollback: () => {
        rollbackCalls++;
        return Promise.resolve();
      },
    };

    let error: unknown;
    try {
      await commitTransactionOrAbort(transaction, context);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: ERP_COMMIT_OUTCOME_UNKNOWN,
      retryable: true,
      abortBatch: true,
      cause: commitCause,
    });
    // Once COMMIT was sent, rollback cannot resolve whether it persisted.
    expect(rollbackCalls).toBe(0);
  });

  it("makes a rejected rollback batch-aborting and preserves both causes", async () => {
    const injectionCause = new Error("contract query timed out");
    const rollbackCause = new Error("connection was terminated");

    let error: unknown;
    try {
      await rollbackTransactionOrAbort(
        { rollback: () => Promise.reject(rollbackCause) },
        context,
        injectionCause,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: ERP_ROLLBACK_FAILED,
      retryable: true,
      abortBatch: true,
    });
    expect(error).toBeInstanceOf(InjectError);
    const aggregate = (error as InjectError).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([
      injectionCause,
      rollbackCause,
    ]);
  });
});

function recoveryExpectation(
  overrides: Partial<ErpPedidoRecoveryExpectation> = {},
): ErpPedidoRecoveryExpectation {
  return {
    ref: "PORTAL-4242",
    codcli: 3,
    includedLineCount: 1,
    includedNetoCents: 9995,
    ...overrides,
  };
}

function recoveredHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SRC: "pedclica",
    CAN: "B",
    EJE: 25,
    NUMPED: 501,
    NUMPEDCLI: "PORTAL-4242",
    CODCLI: 3,
    NETO: 99.95,
    ...overrides,
  };
}

/** The `SELECT COUNT(*)` recordset the recovery line check reads. */
function lineCountRow(count: number): Record<string, unknown>[] {
  return [{ "": count }];
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
    // Business dates are parameters sampled once from SQL Server. The only
    // remaining literals are the two fixed Wingest status values.
    expect(literals).toEqual(["'0'", "'Abierto'"]);
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

/**
 * The second deliberate departure from v3.2, and the one that leaves the SQL
 * text alone: the STATEMENT above is byte-identical to the reference, while two
 * of its parameters now carry different numbers.
 *
 * DEVIATION, owner's decision of **2026-08-16**: a portal quantity means CAJAS.
 * v3.2 was handed base units and DIVIDED to guess the case count
 * (`CAJ = [int][math]::Round(qty/UNILOT)`); the portal knows the case count
 * exactly, so `@QTY` (CANPED/CANSER) became `qty x units_per_case` and `@CAJ`
 * became the quantity itself. The evidence is on both sides of the same table:
 * our injected albarán 5992 wrote `CAJ=1, CANSER=2` for an order of two cajas,
 * while the staff-written lines beside it read `CAJ=5, CANSER=120, PREVEN=0.99`
 * and `CAJ=10, CANSER=240`. `@PRE` did not move: PREVEN has always been the
 * price of one BASE unit, which is exactly what the portal stores.
 */
describe("pedclili quantities vs the v3.2 reference — the 2026-08-16 caja decision", () => {
  const params = buildLineParams({
    can: "B",
    eje: 26,
    numped: 501,
    numlin: 5,
    codcli: 3,
    alm: "00001",
    fecent: new Date(Date.UTC(2026, 7, 20)),
    idlinea: 700100,
    line: cajaLine(),
  });

  it("sends base units as CANPED/CANSER and the case count as CAJ", () => {
    // Both quantity columns read @QTY, so one parameter is both CANPED and
    // CANSER — the property that makes the line servible.
    const byColumn = new Map(PEDCLILI_COLUMNS);
    expect(byColumn.get("CANPED")).toBe("@QTY");
    expect(byColumn.get("CANSER")).toBe("@QTY");
    expect(byColumn.get("CAJ")).toBe("@CAJ");
    expect(params.QTY.value).toBe(48);
    expect(params.CAJ.value).toBe(2);
    // What albarán 5992 got wrong, spelled out: the case count is NOT the
    // quantity, and 1 is not the case count.
    expect(params.QTY.value).not.toBe(2);
    expect(params.CAJ.value).not.toBe(1);
  });

  it("keeps PREVEN per base unit and SUBTOT the portal's own total", () => {
    expect(params.PRE.value).toBe(0.96);
    expect(params.SUB.value).toBe(46.08);
    // The identity that ties the two systems: base units x PREVEN = SUBTOT, and
    // the portal's per-caja price (23.04) x cajas is the same 46.08.
    expect(lineSubtotalCents(2, 24, 96)).toBe(4608);
    expect(2 * 96 * 24).toBe(4608);
  });

  it("writes the ERP's own UNILOT, not the portal's factor", () => {
    // They are the same number in a synced catalogue (price-sync copies UNILOT
    // into units_per_case nightly), but the column belongs to `articulo`.
    expect(params.UNILOT.value).toBe(24);
  });
});

/**
 * The weighed line, decided 2026-08-17 after review: CAJ is 0, not a truncated
 * kilo count.
 *
 * `@CAJ` is an `[int]` parameter, so `P.int(5.2)` does not fail — it TRUNCATES,
 * and a half-kilo line would have gone in as `CAJ=0` while a 5.2 kg line went in
 * as `CAJ=5`, which reads on the albarán as five cases of lemons. The kilos are
 * already carried exactly by CANPED/CANSER (`@QTY`), and Wingest's own UI leaves
 * Cajas at 0 on a KILO line, so 0 is both the honest number and the shape its
 * pedido→albarán conversion already expects.
 */
describe("pedclili on a weighed line", () => {
  const weighed = (overrides: Partial<PreparedLine> = {}) =>
    preparedLine({
      codart: "F-003",
      qty: 5.2,
      isWeighed: true,
      qtyBase: 5.2,
      unitPriceCents: 139,
      prevenEuros: 1.39,
      lineTotalEuros: 7.23,
      lineTotalCents: 723,
      portalLineTotalCents: 723,
      unilot: 1,
      unidad: "KG",
      ...overrides,
    });

  const params = buildLineParams({
    can: "B",
    eje: 26,
    numped: 501,
    numlin: 5,
    codcli: 3,
    alm: "00001",
    fecent: new Date(Date.UTC(2026, 7, 20)),
    idlinea: 700100,
    line: weighed(),
  });

  it("sends the kilos as CANPED/CANSER and 0 cajas", () => {
    expect(params.QTY.value).toBe(5.2);
    expect(params.CAJ.value).toBe(0);
  });

  it("does not truncate the kilos into a case count", () => {
    // What `P.int(line.qty)` would have written, spelled out so a future edit
    // that reintroduces it fails here.
    expect(params.CAJ.value).not.toBe(5);
    expect(params.CAJ.value).not.toBe(Math.trunc(5.2));
  });

  it("keeps CAJ at 0 for a sub-kilo line too", () => {
    // The case truncation was already silently producing this number for half a
    // kilo; now it is the number on purpose, and CANSER still carries the 0.5.
    const half = buildLineParams({
      can: "B",
      eje: 26,
      numped: 501,
      numlin: 10,
      codcli: 3,
      alm: "00001",
      fecent: new Date(Date.UTC(2026, 7, 20)),
      idlinea: 700101,
      line: weighed({ qty: 0.5, qtyBase: 0.5, lineTotalCents: 70 }),
    });
    expect(half.QTY.value).toBe(0.5);
    expect(half.CAJ.value).toBe(0);
  });

  it("leaves a non-weighed line's CAJ exactly as it was", () => {
    expect(buildLineParams({
      can: "B",
      eje: 26,
      numped: 501,
      numlin: 5,
      codcli: 3,
      alm: "00001",
      fecent: new Date(Date.UTC(2026, 7, 20)),
      idlinea: 700100,
      line: cajaLine(),
    }).CAJ.value).toBe(2);
  });
});

describe("pickLot — the 2026-08-16 availability deviation and the 2026-08-21 ladder", () => {
  /** One statement now, on every path: the ladder ranks in SQL. */
  async function onePick(
    overrides: Partial<BridgeConfig> = {},
  ): Promise<RecordedCall[]> {
    const { parent, calls } = fakeParent([[]]);
    await pickLot(parent, { ...cfg, ...overrides }, "4-007", 5, true);
    expect(calls).toHaveLength(1);
    return calls;
  }

  /** One ranked row, as the ladder returns it. */
  function lotRow(overrides: Record<string, unknown> = {}) {
    return {
      TIER: 1,
      LOT: "VCY111B",
      FECCAD: new Date(Date.UTC(2027, 4, 1)),
      DISPO: 80,
      DIASCAD: -300,
      ...overrides,
    };
  }

  it("no longer filters or orders on raw CANT, as v3.2 did", async () => {
    const calls = await onePick();
    expect(calls[0].text).not.toBe(V32_LOT_COVERING_SQL);
    expect(calls[0].text).not.toBe(V32_LOT_FALLBACK_SQL);
    // The raw-quantity predicates themselves, in every spelling v3.2 used.
    expect(calls[0].text).not.toMatch(/CANT>=@qty|CANT>0|ORDER BY CANT/);
  });

  it("subtracts what open pedidos still hold", async () => {
    const calls = await onePick();
    expect(calls[0].text).toContain(LOT_AVAILABLE_SQL);
    // The reservation itself: outstanding = CANPED-CANSER on OPEN pedidos,
    // each quantity NULL-safe so one NULL column cannot void the whole sum.
    expect(calls[0].text).toContain(
      "SELECT SUM(ISNULL(l.CANPED,0) - ISNULL(l.CANSER,0)) FROM pedclili l",
    );
    expect(calls[0].text).toContain("c.ESTPED='Abierto'");
    // Byte for byte, against the text pinned at the top of this file — not
    // merely against the constants the module happens to export today.
    expect(LOT_AVAILABLE_SQL).toBe(LOT_RESERVATION_SQL);
    expect(LOT_PICK_SQL).toBe(EXPECTED_LOT_PICK_SQL);
    expect(calls[0].text).toBe(EXPECTED_LOT_PICK_SQL);
  });

  it("wraps the reservation in ISNULL, so a lot nobody booked is not NULL", () => {
    // Without it SUM() over no rows is NULL, `CANT - NULL` is NULL, and NULL
    // fails every comparison — every unbooked lot would drop out of the pick.
    expect(LOT_AVAILABLE_SQL).toContain("ISNULL((SELECT SUM(");
    expect(LOT_AVAILABLE_SQL).toContain("), 0)");
    expect(LOT_AVAILABLE_SQL.startsWith("(s.CANT - ISNULL(")).toBe(true);
  });

  it("keeps the reservation sum NULL-safe on both quantity columns", () => {
    // `SUM(a - b)` skips a row whose `a` or `b` is NULL, so one NULL column in a
    // Wingest-written line would quietly stop that line reserving anything.
    expect(LOT_AVAILABLE_SQL).toContain("ISNULL(l.CANPED,0) - ISNULL(l.CANSER,0)");
  });

  it("leaves the correlation predicates seekable — no RTRIM on a column pair", () => {
    // Trailing blanks are insignificant in char equality (SQL Server blank-pads
    // the shorter side), so `RTRIM` here would buy nothing and cost the index on
    // a shared ERP box. The RTRIMs that remain compare against a PARAMETER or
    // shape a returned value; neither is a correlation.
    const reservation = LOT_AVAILABLE_SQL;
    for (const pair of ["l.CODALM=s.CODALM", "l.CODART=s.CODART", "l.CODLOT=s.CODLOT"]) {
      expect(reservation).toContain(pair);
    }
    expect(reservation).not.toContain("RTRIM");
  });

  it("labels the collation of every correlation predicate, on the s side only", () => {
    // The 2026-08-16 sandbox run (order 1006) failed PREFLIGHT with "Cannot
    // resolve the collation conflict between Modern_Spanish_CS_AS and
    // Modern_Spanish_CI_AS in the equal to operation": pedclili and stolot do
    // not share a collation, and two IMPLICIT labels give SQL Server no rule to
    // pick between them. An EXPLICIT label wins over an implicit one, so one
    // side carrying it resolves the comparison whichever table is the odd one
    // out. It is the `s` side — one outer-row value per evaluation — so the
    // pedclili/pedclica lookups stay seekable when pedclili already matches the
    // database default; if it does not, that costs a seek, never correctness.
    const reservation = LOT_AVAILABLE_SQL;
    for (const col of ["CODALM", "CODART", "CODLOT"]) {
      expect(reservation).toContain(`l.${col}=s.${col} COLLATE DATABASE_DEFAULT`);
      // The l side stays bare: labelling the subquery's own column is what
      // would make its index unusable.
      expect(reservation).not.toContain(`l.${col} COLLATE`);
    }
    // Three predicates, three labels — no more (a stray one on `s.CODALM=@alm`
    // or on the ESTPED literal would be dead weight) and no fewer.
    expect(reservation.match(/COLLATE DATABASE_DEFAULT/g)).toHaveLength(3);
    // The literal comparison takes the column's collation and needs nothing.
    expect(reservation).toContain("c.ESTPED='Abierto' AND");
    expect(reservation).not.toMatch(/ESTPED\s*=\s*'Abierto'\s+COLLATE/);
  });

  it("names the reservation once, so the collation labels appear exactly three times", () => {
    // CROSS APPLY (VALUES ...) names the availability expression once instead of
    // pasting it into the CASE, the WHERE and the ORDER BY — which is also what
    // keeps this count at three. A FOURTH label means somebody added a new
    // cross-table string comparison without thinking about the 2026-08-16 trap.
    expect(LOT_PICK_SQL.match(/COLLATE DATABASE_DEFAULT/g)).toHaveLength(3);
    expect(LOT_PICK_SQL).toContain("CROSS APPLY (VALUES");
  });

  it("does not scope the reservation to an ejercicio", async () => {
    // An open pedido from an earlier EJE still holds its stock and Wingest still
    // counts it. The one EJE comparison allowed is the line↔header correlation
    // (`pedclili`'s key is CAN/EJE/NUMPED/NUMLIN) — never `cfg.eje`.
    const calls = await onePick();
    expect(calls[0].text).not.toContain("@eje");
    const comparisons = calls[0].text.match(/[\w.]*EJE\s*=\s*[\w.@']+/gi) ?? [];
    expect([...new Set(comparisons)]).toEqual(["c.EJE=l.EJE"]);
    expect(Object.keys(calls[0].params).sort()).toEqual(["alm", "codart", "qty"]);
  });

  it("counts only reservations on the same almacén, article and lot", async () => {
    const calls = await onePick();
    expect(calls[0].text).toContain("l.CODALM=s.CODALM");
    expect(calls[0].text).toContain("l.CODART=s.CODART");
    expect(calls[0].text).toContain("l.CODLOT=s.CODLOT");
    // The lot row itself stays scoped to the configured almacén, as before.
    expect(calls[0].text).toContain("s.CODALM=@alm AND RTRIM(s.CODART)=@codart");
  });

  it("keeps v3.2's sellable and freshness predicates untouched", async () => {
    const calls = await onePick();
    expect(LOT_FRESH_SQL).toBe(EXPECTED_LOT_FRESH_SQL);
    expect(calls[0].text).toContain(EXPECTED_LOT_FRESH_SQL);
    expect(calls[0].text).toContain("s.VENDIBLE=1");
  });

  it("excludes a lot whose FECCAD is NULL, as both v3.2 queries already did", () => {
    // v3.2's predicate evaluates to NULL for a NULL FECCAD, so such a row never
    // reached either query. Without this filter the CASE would fall through to
    // the expired arms and reclassify "expiry unknown" as "expired", pushing a
    // dateless lot into the gated tiers. NULL is not expiry.
    expect(LOT_PICK_SQL).toContain("AND s.FECCAD IS NOT NULL");
  });

  it("ranks freshness above coverage, so a fresh short lot beats an expired covering one", () => {
    expect(LOT_TIER_SQL).toBe(EXPECTED_LOT_TIER_SQL);
    expect(LOT_ORDER_SQL).toBe(EXPECTED_LOT_ORDER_SQL);
  });

  it("inverts FIFO inside the expired tiers — least expired first, never lot C26 first", () => {
    // Tier 1 keeps v3.2's FIFO. Tiers 3-4 reverse it on purpose: among lots
    // already past their date, take the LEAST expired. FIFO there would reach
    // for 10-121's lot C26 (CANT=80, expired 2022-08-24) before anything else.
    expect(LOT_ORDER_SQL).toContain("CASE WHEN t.TIER=1 THEN s.FECCAD END ASC");
    expect(LOT_ORDER_SQL).toContain("CASE WHEN t.TIER>=3 THEN s.FECCAD END DESC");
    // Tier 2 has neither key and falls through to availability, which is what
    // the retired LOT_FALLBACK_SQL sorted by.
    expect(LOT_ORDER_SQL).toContain("a.DISPO DESC");
  });

  it("costs exactly one round trip on every path", async () => {
    for (const recordset of [
      [lotRow()],
      [lotRow({ TIER: 3, DIASCAD: 144 })],
      [lotRow({ TIER: 4, DIASCAD: 1458 })],
      [],
    ]) {
      const { parent, calls } = fakeParent([recordset]);
      await pickLot(parent, cfg, "4-007", 5, true);
      expect(calls).toHaveLength(1);
    }
  });

  it("maps every TIER the ladder can return", async () => {
    const expected: Array<[number, string]> = [
      [1, "fresh_covering"],
      [2, "fresh_partial"],
      [3, "expired_covering"],
      [4, "expired_partial"],
    ];
    for (const [code, tier] of expected) {
      const { parent } = fakeParent([[lotRow({ TIER: code, DIASCAD: 144 })]]);
      const lot = await pickLot(parent, cfg, "4-007", 5, true);
      expect(lot.tier).toBe(tier);
    }
  });

  it("uses a fresh lot outright, covering or short", async () => {
    for (const code of [1, 2]) {
      const { parent } = fakeParent([[lotRow({ TIER: code })]]);
      expect(await pickLot(parent, cfg, "4-007", 5, true)).toEqual({
        codlot: "VCY111B",
        feccad: new Date(Date.UTC(2027, 4, 1)),
        tier: code === 1 ? "fresh_covering" : "fresh_partial",
        outcome: "lot_used",
        dispo: 80,
        // Days-past-expiry is meaningless on an in-date row and is not reported.
        diasCad: null,
      });
    }
  });

  it("refuses an expired lot while BRIDGE_LOT_ALLOW_EXPIRED is off — but reports it", async () => {
    // The refusal is the shipped default AND the measurement: the row is still
    // selected, so `lotBlocked` can tell the owner how many lines the rescue
    // would have saved before he decides whether to open the door.
    const { parent, calls } = fakeParent([[lotRow({ TIER: 3, DIASCAD: 144 })]]);
    expect(await pickLot(parent, cfg, "4-007", 5, true)).toEqual({
      codlot: "",
      feccad: NO_EXPIRY_DATE,
      tier: "expired_covering",
      outcome: "expired_refused",
      dispo: 80,
      diasCad: 144,
    });
    expect(calls).toHaveLength(1);
  });

  it("uses an expired lot only inside the configured day window", async () => {
    const open = { lotAllowExpired: true, lotExpiredMaxDays: 180 };
    // 100-002A's lot 037: 144 days stale on 2026-08-21, the case the window exists for.
    const { parent } = fakeParent([[lotRow({ TIER: 3, DIASCAD: 144 })]]);
    expect(await pickLot(parent, { ...cfg, ...open }, "4-007", 5, true)).toEqual({
      codlot: "VCY111B",
      feccad: new Date(Date.UTC(2027, 4, 1)),
      tier: "expired_covering",
      outcome: "expired_used",
      dispo: 80,
      diasCad: 144,
    });
    // 10-121's lot C26: 1,458 days stale, unreachable at every legal setting.
    const old = fakeParent([[lotRow({ TIER: 4, DIASCAD: 1458 })]]);
    const refused = await pickLot(old.parent, { ...cfg, ...open }, "4-007", 5, true);
    expect(refused.outcome).toBe("expired_too_old");
    expect(refused.codlot).toBe("");
    // An unreadable DIASCAD is refused too: unknown staleness is not "fresh".
    const unknown = fakeParent([[lotRow({ TIER: 3, DIASCAD: null })]]);
    expect(
      (await pickLot(unknown.parent, { ...cfg, ...open }, "4-007", 5, true)).outcome,
    ).toBe("expired_too_old");
  });

  it("passes an expired FECCAD through UNCHANGED — never sanitised to 1900-01-01", async () => {
    // Sanitising it would erase the only trace of the decision visible inside
    // Wingest and would contradict the stolot row the same document points at.
    const expired = new Date(Date.UTC(2026, 2, 30));
    const { parent } = fakeParent([
      [lotRow({ TIER: 3, FECCAD: expired, DIASCAD: 144 })],
    ]);
    const lot = await pickLot(
      parent,
      { ...cfg, lotAllowExpired: true, lotExpiredMaxDays: 180 },
      "4-007",
      5,
      true,
    );
    expect(lot.feccad).toEqual(expired);
  });

  it("never asks stolot about an article the ERP does not lot-control", async () => {
    // F-003 is CONLOT=false and its hand-written albaranes ship with an EMPTY
    // CODLOT every day: here an empty lot is the CORRECT value, not a fallback.
    const { parent, calls } = fakeParent([]);
    expect(await pickLot(parent, cfg, "F-003", 24, false)).toEqual({
      codlot: "",
      feccad: NO_EXPIRY_DATE,
      tier: "none",
      outcome: "not_lot_controlled",
      dispo: null,
      diasCad: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps v3.2's answer when no lot is available at all", async () => {
    const { parent } = fakeParent([[]]);
    expect(await pickLot(parent, cfg, "4-007", 5, true)).toEqual({
      codlot: "",
      feccad: NO_EXPIRY_DATE,
      tier: "none",
      outcome: "no_stock",
      dispo: null,
      diasCad: null,
    });
  });

  it("treats an unmappable TIER as no stock, never as an expired lot", async () => {
    // A malformed recordset must not drop through to the expiry gate, where a
    // permissive config would write whatever lot code came back.
    const { parent } = fakeParent([[lotRow({ TIER: 9 })]]);
    const lot = await pickLot(parent, cfg, "4-007", 5, true);
    expect(lot.outcome).toBe("no_stock");
    expect(lot.codlot).toBe("");
  });

  it("never puts a value into the SQL text", async () => {
    const calls = await onePick();
    for (const value of ["00001", "4-007", "5"]) {
      expect(calls[0].text).not.toContain(value);
    }
    expect(calls[0].params.alm.value).toBe("00001");
    expect(calls[0].params.codart.value).toBe("4-007");
    expect(calls[0].params.qty.value).toBe(5);
  });
});

describe("lotFlagsFor", () => {
  it("reports only the lines a human should look at", () => {
    // The channel has to stay quiet enough to be believed: a clean fresh line
    // and a correctly-lotless one say nothing, and 953 of 2,302 live articles
    // are the second kind.
    const flags = lotFlagsFor([
      preparedLine({ codart: "1-006" }),
      preparedLine({
        codart: "F-003",
        codlot: "",
        feccad: NO_EXPIRY_DATE,
        lotTier: "none",
        lotOutcome: "not_lot_controlled",
        lotDispo: null,
      }),
      preparedLine({
        codart: "100-003",
        codlot: "",
        feccad: NO_EXPIRY_DATE,
        lotTier: "none",
        lotOutcome: "no_stock",
        lotDispo: null,
      }),
      preparedLine({
        codart: "100-002A",
        codlot: "",
        feccad: NO_EXPIRY_DATE,
        lotTier: "expired_covering",
        lotOutcome: "expired_refused",
        lotDispo: 18,
        lotDiasCad: 144,
      }),
    ]);
    expect(flags.map((flag) => [flag.codart, flag.outcome])).toEqual([
      ["100-003", "no_stock"],
      ["100-002A", "expired_refused"],
    ]);
    // No lot was written, so there is no date to report — null, not 1900-01-01,
    // which would read as a real "no expiry" lot.
    expect(flags.every((flag) => flag.feccad === null)).toBe(true);
  });

  it("reports a fresh but SHORT line, and dates the lot it wrote", () => {
    // `lot_used` and no regression, but Wingest may still refuse it at
    // conversion, so it belongs on the per-order line.
    const [flag] = lotFlagsFor([
      preparedLine({ lotTier: "fresh_partial", lotDispo: 2 }),
    ]);
    expect(flag.outcome).toBe("lot_used");
    expect(flag.tier).toBe("fresh_partial");
    expect(flag.codlot).toBe("VCY111B");
    expect(flag.feccad).toBe("2027-05-01");
    expect(flag.dispo).toBe(2);
    expect(flag.qtyBase).toBe(5);
  });

  it("says nothing at all about a clean order", () => {
    expect(lotFlagsFor([preparedLine(), preparedLine()])).toEqual([]);
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
    fecped: new Date(Date.UTC(2026, 7, 16)),
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
  });

  it("sends the quantity as base units and the same number of cajas at factor 1", () => {
    expect(params.QTY.value).toBe(5);
    expect(params.CAJ.value).toBe(5);
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

describe("baseUnitsForLine", () => {
  it("multiplies cajas by the factor the order was priced with", () => {
    expect(baseUnitsForLine(2, 24)).toBe(48);
    expect(baseUnitsForLine(10, 24)).toBe(240);
    expect(baseUnitsForLine(5, 2)).toBe(10);
  });

  it("leaves a factor-1 line exactly as the customer typed it", () => {
    expect(baseUnitsForLine(5, 1)).toBe(5);
    expect(baseUnitsForLine(1, 1)).toBe(1);
  });

  it("carries a fractional quantity through untouched (the weighed future)", () => {
    // A weighed product is factor 1 by rule, and `x * 1` is exact for every
    // double — 1.235 kg must not become 1.2349999999999999.
    expect(baseUnitsForLine(1.235, 1)).toBe(1.235);
    expect(baseUnitsForLine(0.5, 1)).toBe(0.5);
    expect(baseUnitsForLine(2.4, 1)).toBe(2.4);
  });

  it("never divides — the answer only ever grows", () => {
    for (const [qty, factor] of [
      [3, 12],
      [7, 6],
      [1, 576],
    ] as const) {
      expect(baseUnitsForLine(qty, factor)).toBeGreaterThanOrEqual(qty);
    }
  });
});

describe("lineSubtotalCents", () => {
  it("is cajas times the factor times the per-base-unit price, exactly", () => {
    expect(lineSubtotalCents(2, 24, 96)).toBe(4608);
    expect(lineSubtotalCents(5, 1, 1999)).toBe(9995);
    expect(lineSubtotalCents(10, 24, 99)).toBe(23_760);
  });

  it("matches create_order's rounding for a fractional quantity", () => {
    // The portal stores `round(qty x units x price)`; this reproduces it rather
    // than drifting half a cent from the amount the customer was charged.
    expect(lineSubtotalCents(1.235, 1, 1999)).toBe(2469);
    expect(lineSubtotalCents(0.5, 1, 101)).toBe(51);
    // The owner's own example: 柠檬 F-003 at 1.39 €/kg, weighed at 5.2 kg. The
    // live database answered 723 for exactly this line (2026-08-16).
    expect(lineSubtotalCents(5.2, 1, 139)).toBe(723);
  });

  /**
   * The half-cent ties, which are the whole reason this function does not
   * multiply doubles.
   *
   * Postgres computes `qty x units x price` in exact `numeric` and rounds HALF
   * AWAY FROM ZERO, so each of these lines is stored one cent higher than the
   * naive `Math.round(qtyBase * unitPriceCents)` produces — and one cent is
   * enough for the SUBTOT contract check to refuse the order, on this run and
   * on every lease retry after it. A weighed line that can never be injected is
   * worse than a wrong one: it is invisible until somebody asks why a pedido
   * from last Tuesday never reached Wingest.
   */
  it("rounds an exact half cent the way Postgres numeric does", () => {
    expect(lineSubtotalCents(1.005, 1, 100)).toBe(101);
    expect(lineSubtotalCents(4.1, 1, 15)).toBe(62);
    expect(lineSubtotalCents(2.3, 1, 25)).toBe(58);
    expect(lineSubtotalCents(0.145, 1, 100)).toBe(15);
  });

  it("is not the double arithmetic it replaced", () => {
    // The bug, pinned: every one of these lands just BELOW the tie in binary
    // floating point, so the old `Math.round(qtyBase * unitPriceCents)` rounded
    // down and disagreed with the portal by a cent.
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(Math.round(4.1 * 15)).toBe(61);
    expect(Math.round(2.3 * 25)).toBe(57);
    expect(Math.round(0.145 * 100)).toBe(14);
  });

  it("stays exact where multiplying euros would not", () => {
    // 10 cajas of 24 at 0.03 € is 7.199999999999999 in float euros; done in
    // cents it is 720, and 720/100 is exactly 7.2. This is why the invariant
    // compares CENTS and not the euro amounts the ERP columns hold.
    expect(240 * 0.03).not.toBe(7.2);
    expect(lineSubtotalCents(10, 24, 3) / 100).toBe(7.2);
  });

  it("stays exact at the caps the write paths enforce", () => {
    // The magnitude bound in the doc comment, exercised rather than asserted.
    // The largest quantity the cart can hold, at three decimals:
    // 9,999,999 milli-cajas x 99 cents = 989,999,901 milli-cents = 989,999.901,
    // which rounds to 990,000 and never stopped being an exact integer.
    expect(lineSubtotalCents(9999.999, 1, 99)).toBe(990_000);
    // …and the widest product the two write RPCs can let through — the 1e6 cap
    // on `qty x units_per_case`, at a price that still fits int4 cents — is four
    // orders of magnitude short of where a double stops counting exactly.
    const widest = Math.round(1_000_000 * 1000) * 1 * 2000;
    expect(Number.isSafeInteger(widest)).toBe(true);
    expect(widest).toBeLessThan(Number.MAX_SAFE_INTEGER / 4000);
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
  it("returns the stored CAN/EJE/NUMPED from either header table", async () => {
    const { parent, calls } = fakeParent([
      [recoveredHeader({ CAN: "b " })],
      lineCountRow(1),
    ]);
    expect(await dedupCheck(parent, cfg, recoveryExpectation())).toEqual({
      can: "B",
      eje: 25,
      numped: 501,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain(
      "SELECT TOP 1 z.SRC, z.CAN, z.EJE, z.NUMPED, z.NUMPEDCLI, z.CODCLI, z.NETO",
    );
    expect(calls[0].text).toContain("FROM pedclica ");
    expect(calls[0].text).toContain("FROM pedclicah ");
    expect(calls[0].text).not.toContain("PORTAL-4242");
    expect(calls[0].params.ext.value).toBe("PORTAL-4242");
    expect(calls[0].params.can.value).toBe("B");
  });

  it("counts the real lines rather than trusting the header's ULTLIN", async () => {
    const { parent, calls } = fakeParent([[recoveredHeader()], lineCountRow(1)]);
    await dedupCheck(parent, cfg, recoveryExpectation());
    expect(calls[0].text).not.toContain("ULTLIN");
    expect(calls[1].text).toBe(
      "SELECT COUNT(*) FROM pedclili WHERE CAN=@can AND EJE=@eje AND NUMPED=@numped",
    );
    // The identity the HEADER carried, not today's configuration.
    expect(calls[1].params.can.value).toBe("B");
    expect(calls[1].params.eje.value).toBe(25);
    expect(calls[1].params.numped.value).toBe(501);
  });

  it("counts the history lines table when the hit came from history", async () => {
    const { parent, calls } = fakeParent([
      [recoveredHeader({ SRC: "pedclicah", EJE: 24 })],
      lineCountRow(1),
    ]);
    expect(await dedupCheck(parent, cfg, recoveryExpectation())).toEqual({
      can: "B",
      eje: 24,
      numped: 501,
    });
    expect(calls[1].text).toContain("FROM pedclilih WHERE");
  });

  it("rejects a recovery whose lines are missing from the ERP", async () => {
    const { parent } = fakeParent([[recoveredHeader()], lineCountRow(0)]);
    await expect(dedupCheck(parent, cfg, recoveryExpectation())).rejects.toMatchObject({
      code: ERP_PEDIDO_RECOVERY_MISMATCH,
      retryable: false,
    });
  });

  it("rejects a recovery carrying more lines than the portal order", async () => {
    const { parent } = fakeParent([[recoveredHeader()], lineCountRow(2)]);
    await expect(dedupCheck(parent, cfg, recoveryExpectation())).rejects.toMatchObject({
      code: ERP_PEDIDO_RECOVERY_MISMATCH,
      retryable: false,
    });
  });

  it("fails closed on a header source it does not know", async () => {
    const { parent } = fakeParent([[recoveredHeader({ SRC: "somewhere" })]]);
    await expect(dedupCheck(parent, cfg, recoveryExpectation())).rejects.toMatchObject({
      code: ERP_PEDIDO_IDENTITY_INVALID,
      retryable: false,
    });
  });

  it("is null when the portal ref has never been injected", async () => {
    const { parent } = fakeParent([[]]);
    expect(await dedupCheck(parent, cfg, recoveryExpectation())).toBeNull();
  });

  it.each([
    { CAN: "", EJE: 25, NUMPED: 501 },
    { CAN: "ABC", EJE: 25, NUMPED: 501 },
    { CAN: "B", EJE: 0, NUMPED: 501 },
    { CAN: "B", EJE: 25.5, NUMPED: 501 },
    { CAN: "B", EJE: 10_000, NUMPED: 501 },
    { CAN: "B", EJE: 25, NUMPED: 0 },
    { CAN: "B", EJE: 25, NUMPED: 501.5 },
    { CAN: "B", EJE: 25, NUMPED: 2_147_483_648 },
    { CAN: "B", EJE: null, NUMPED: 501 },
    { CAN: "B", EJE: 25, NUMPED: null },
  ])("fails closed on an invalid stored identity: %o", async (row) => {
    const { parent } = fakeParent([[recoveredHeader(row)]]);
    await expect(dedupCheck(parent, cfg, recoveryExpectation())).rejects.toMatchObject({
      code: ERP_PEDIDO_IDENTITY_INVALID,
      retryable: false,
    });
  });

  it.each([
    ["PORTAL ref", { NUMPEDCLI: "PORTAL-9999" }],
    ["CODCLI", { CODCLI: 4 }],
    ["included NETO", { NETO: 99.94 }],
  ])("rejects a fake recovery whose %s differs", async (_field, override) => {
    const { parent } = fakeParent([[recoveredHeader(override)]]);
    await expect(dedupCheck(parent, cfg, recoveryExpectation())).rejects.toMatchObject({
      code: ERP_PEDIDO_RECOVERY_MISMATCH,
      retryable: false,
    });
  });
});

describe("preflightOrder", () => {
  it("recovers before mutable customer/article/tax/lot master data is read", async () => {
    const { parent, calls } = fakeParent([
      [{ "": "wg_test" }],
      [recoveredHeader({ EJE: 25, NUMPED: 777 })],
      lineCountRow(1),
      // Deliberately no customer/article/tax/lot responses. If recovery moved
      // behind prepareOrder again, the missing customer row would fail here.
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
    await expect(preflightOrder(parent, cfg, order)).resolves.toEqual({
      kind: "recovered",
      identity: { can: "B", eje: 25, numped: 777 },
      excludedCodarts: ["SERVICIO-1"],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].text).toBe("SELECT DB_NAME()");
    expect(calls[1].text).toContain("FROM pedclica");
    expect(calls[2].text).toContain("SELECT COUNT(*) FROM pedclili");
    expect(calls.some((call) => call.text.includes("FROM clientes"))).toBe(false);
    expect(calls.some((call) => call.text.includes("FROM articulo"))).toBe(false);
    expect(calls.some((call) => call.text.includes("FROM stolot"))).toBe(false);
  });

  it("fails permanently instead of accepting a matching ref with a wrong header", async () => {
    const { parent, calls } = fakeParent([
      [{ "": "wg_test" }],
      [recoveredHeader({ CODCLI: 999 })],
    ]);

    await expect(preflightOrder(parent, cfg, claimedOrder())).rejects.toMatchObject({
      code: ERP_PEDIDO_RECOVERY_MISMATCH,
      retryable: false,
    });
    expect(calls).toHaveLength(2);
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

  it("permanently rejects a NUMPED that cannot be stored in the portal", async () => {
    const { parent } = fakeParent([[{ NUMERO: 2_147_483_648 }]]);
    await expect(reserveCounters(parent, cfg, 1)).rejects.toMatchObject({
      code: ERP_NUMPED_COUNTER_INVALID,
      retryable: false,
    });
  });
});

describe("contractChecks", () => {
  const ok = [[{ "": 1 }], [{ "": 2 }], [{ "": 1 }], [{ "": 1 }]];
  const twoLines = [preparedLine(), cajaLine()];

  it("passes when the header, both lines, the user and the adi row all check out", async () => {
    const { parent, calls } = fakeParent(ok);
    await expect(contractChecks(parent, cfg, 501, 3, twoLines)).resolves.toBeUndefined();
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
    await expect(contractChecks(parent, cfg, 501, 3, twoLines)).rejects.toThrow(
      /CONTRATO: cabecera/,
    );
  });

  it("fails when a line is not servible", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 1 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, twoLines)).rejects.toThrow(
      /CONTRATO: lineas servibles 1 de 2/,
    );
  });

  it("fails when the ERP user does not exist", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 2 }], [{ "": 0 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, twoLines)).rejects.toThrow(
      /usuario SFY no existe/,
    );
  });

  it("fails when pedclica_adi is not exactly one row", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 2 }], [{ "": 1 }], [{ "": 0 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, twoLines)).rejects.toThrow(/pedclica_adi/);
  });

  it("refuses a SUBTOT that is not base units x PREVEN, before any query runs", async () => {
    // The realistic way to get here: the line was claimed before the RPC carried
    // `units_per_case`, so the factor defaulted to 1 and the pedido would have
    // ordered 2 bottles of a product the customer bought 2 CAJAS of.
    const { parent, calls } = fakeParent(ok);
    const stale = cajaLine({ qtyBase: 2, lineTotalCents: 192, lineTotalEuros: 1.92 });
    await expect(contractChecks(parent, cfg, 501, 3, [stale])).rejects.toThrow(
      /CONTRATO: SUBTOT de 1-001 — 2 x 96 = 192 céntimos, el portal cobró 4608/,
    );
    // Pure arithmetic: it costs nothing and it runs first, so a mismatch never
    // spends four round trips before rolling the transaction back.
    expect(calls).toHaveLength(0);
  });

  it("passes the caja line whose SUBTOT does match", async () => {
    const { parent } = fakeParent([[{ "": 1 }], [{ "": 1 }], [{ "": 1 }], [{ "": 1 }]]);
    await expect(contractChecks(parent, cfg, 501, 3, [cajaLine()])).resolves.toBeUndefined();
  });
});

describe("runInjectSteps", () => {
  it("recovers the existing cross-year identity without writing anything", async () => {
    const { parent, calls } = fakeParent([
      [recoveredHeader({ NUMPED: 777 })],
      lineCountRow(1),
    ]);
    expect(await runInjectSteps(parent, cfg, preparedOrder())).toEqual({
      can: "B",
      eje: 25,
      numped: 777,
      recovered: true,
    });
    expect(calls).toHaveLength(2);
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
      can: cfg.can,
      eje: cfg.eje,
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

  it("rechecks EJE against SQL Server's Madrid date before master-data preflight", async () => {
    const { parent, calls } = fakeParent([
      [{ "": new Date(Date.UTC(2027, 0, 1)) }],
    ]);

    const error = await prepareOrder(parent, cfg, claimedOrder()).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      code: "EJE_YEAR_MISMATCH",
      retryable: true,
      orderId: "11111111-1111-4111-8111-111111111111",
    });
    // The date check is the only ERP query: no customer/article preflight ran.
    expect(calls).toHaveLength(1);
  });

  it("never lets a historical override escape its exact portal order", async () => {
    const { parent, calls } = fakeParent([
      [{ "": new Date(Date.UTC(2027, 0, 1)) }],
    ]);
    const historicalCfg: BridgeConfig = {
      ...cfg,
      eje: 26,
      allowHistoricalEje: true,
      historicalOrderId: "33333333-3333-4333-8333-333333333333",
    };

    const error = await prepareOrder(parent, historicalCfg, claimedOrder()).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      code: "HISTORICAL_ORDER_SCOPE_VIOLATION",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("allows the exact supervised historical target to keep its configured EJE", async () => {
    const order = claimedOrder();
    const { parent } = fakeParent([
      [{ "": new Date(Date.UTC(2027, 0, 1)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: true }],
      [{ TIER: 1, LOT: "L1", FECCAD: new Date(Date.UTC(2028, 0, 1)), DISPO: 80, DIASCAD: -300 }],
    ]);
    const historicalCfg: BridgeConfig = {
      ...cfg,
      allowHistoricalEje: true,
      historicalOrderId: order.id,
    };

    const prepared = await prepareOrder(parent, historicalCfg, order);

    expect(prepared.fecped.toISOString()).toBe("2027-01-01T00:00:00.000Z");
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
      [{ DES: "ARROZ", PRECOS: 12.3456, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: true }], // articulo
      [{ TIER: 1, LOT: "VCY111B", FECCAD: new Date(Date.UTC(2027, 4, 1)), DISPO: 80, DIASCAD: -300 }], // stolot
    ]);

    const prepared = await prepareOrder(parent, cfg, claimedOrder());

    expect(prepared.ref).toBe("PORTAL-4242");
    expect(prepared.fecped.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(prepared.fecent.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(prepared.customer.tippor).toBe("Portes Debidos");
    expect(prepared.taxes.netoCents).toBe(9995);
    expect(prepared.taxes.ivaCents[1]).toBe(1000);
    expect(prepared.totcosEuros).toBe(61.73);
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0]).toMatchObject({
      codart: "4-007",
      qty: 5,
      qtyBase: 5,
      prevenEuros: 19.99,
      lineTotalEuros: 99.95,
      lineTotalCents: 9995,
      portalLineTotalCents: 9995,
      codlot: "VCY111B",
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
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 0, UNI: "KG", CONLOT: true }],
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
    // An article whose UNILOT the ERP left at 0 no longer zeroes the case count:
    // CAJ comes from the order, not from a division by that column.
    expect(prepared.lines[0].qty).toBe(5);
    expect(prepared.lines[0].unilot).toBe(0);
  });

  /**
   * The `show_delivery_date` switch, seen from the ERP end. With the picker
   * hidden the order is stored with a null `delivery_date`, the claim RPC hands
   * that null straight through the jsonb, and the pedido has to come out dated
   * the Madrid business day — the FECPED semantics a paper order has always had.
   * A throw here would strand the order mid-lease instead.
   */
  it("dates a pedido with no delivery date on the Madrid business day", async () => {
    const { parent } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 0, NUMPAG: 0, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 0, UNI: "KG", CONLOT: true }],
      [],
    ]);
    const prepared = await prepareOrder(
      parent,
      cfg,
      claimedOrder({ delivery_date: null }),
    );
    expect(prepared.fecent.toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });

  it("never asks stolot about a CONLOT=false article, and stamps no lot on it", async () => {
    // F-003 and the other 952 articles the ERP does not lot-control: their
    // hand-written albaranes ship with an EMPTY CODLOT every day, so this is
    // the correct value rather than a fallback — and the query saved is why
    // the ladder costs FEWER round trips than the pair it replaced.
    const { parent, calls } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "NARANJA", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: false }],
    ]);

    const prepared = await prepareOrder(parent, cfg, claimedOrder());

    expect(calls.some((call) => call.text.includes("FROM stolot"))).toBe(false);
    expect(prepared.lines[0]).toMatchObject({
      codlot: "",
      lotTier: "none",
      lotOutcome: "not_lot_controlled",
    });
    expect(prepared.lines[0].feccad).toEqual(NO_EXPIRY_DATE);
    // And the reporting stays silent: a correctly lotless line is not news.
    expect(prepared.lotFlags).toEqual([]);
  });

  it("treats an unset CONLOT bit as lot-controlled and still asks stolot", async () => {
    // Being wrong this way costs one query and an empty CODLOT; being wrong the
    // other way puts a traceability hole on a lot-controlled food line.
    for (const conlot of [null, undefined, 1, true]) {
      const { parent, calls } = fakeParent([
        [{ "": new Date(Date.UTC(2026, 7, 16)) }],
        [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
        [{ T: "G", POSMAT: 1 }],
        [{ C: "N", A: "G", TPCIVA: 10 }],
        [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: conlot }],
        [{ TIER: 1, LOT: "L1", FECCAD: new Date(Date.UTC(2028, 0, 1)), DISPO: 80, DIASCAD: -300 }],
      ]);
      const prepared = await prepareOrder(parent, cfg, claimedOrder());
      expect(calls.some((call) => call.text.includes("FROM stolot"))).toBe(true);
      expect(prepared.lines[0].codlot).toBe("L1");
    }
    // Only the two spellings of an explicit false skip the pick.
    for (const conlot of [false, 0]) {
      const { parent, calls } = fakeParent([
        [{ "": new Date(Date.UTC(2026, 7, 16)) }],
        [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
        [{ T: "G", POSMAT: 1 }],
        [{ C: "N", A: "G", TPCIVA: 10 }],
        [{ DES: "NARANJA", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: conlot }],
      ]);
      const prepared = await prepareOrder(parent, cfg, claimedOrder());
      expect(calls.some((call) => call.text.includes("FROM stolot"))).toBe(false);
      expect(prepared.lines[0].codlot).toBe("");
    }
  });

  it("reads CONLOT off articulo without disturbing the columns it already read", async () => {
    const { parent, calls } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: true }],
      [{ TIER: 1, LOT: "L1", FECCAD: new Date(Date.UTC(2028, 0, 1)), DISPO: 80, DIASCAD: -300 }],
    ]);
    await prepareOrder(parent, cfg, claimedOrder());

    // ONE column added to a statement that already ran per line — no second
    // round trip buys the whole CONLOT gate.
    const article = calls.find((call) => call.text.includes("FROM articulo"));
    expect(article?.text).toBe(
      "SELECT RTRIM(DES) AS DES, PREMEDCOS AS PRECOS, RTRIM(TIPIVAART) AS T," +
        " UNILOT, RTRIM(UNIDAD) AS UNI, CONLOT FROM articulo WHERE CODART=@codart",
    );
  });

  it("multiplies cajas into base units, and asks stolot for those", async () => {
    const { parent, calls } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "CERVEZA 33CL", PRECOS: 0.5, T: "G", UNILOT: 24, UNI: "CAJA", CONLOT: true }],
      [{ TIER: 1, LOT: "L48", FECCAD: new Date(Date.UTC(2027, 4, 1)), DISPO: 80, DIASCAD: -300 }],
    ]);

    // 2 cajas of 1-001: 24 bottles at 0.96 €, portal total 46.08 €.
    const order = claimedOrder({
      subtotal_cents: 4608,
      items: [
        {
          codart: "1-001",
          qty: 2,
          units_per_case: 24,
          unit_price_cents: 96,
          line_total_cents: 4608,
          is_weighed: false,
          is_erp_excluded: false,
        },
      ],
    });
    const prepared = await prepareOrder(parent, cfg, order);

    expect(prepared.lines[0]).toMatchObject({
      qty: 2,
      qtyBase: 48,
      unitPriceCents: 96,
      prevenEuros: 0.96,
      lineTotalCents: 4608,
      portalLineTotalCents: 4608,
      lineTotalEuros: 46.08,
    });
    // The availability check counts BOTTLES: 48, not 2. Picking a lot on the
    // case count would happily choose one with three bottles left on it.
    const lotCall = calls.find((call) => call.text.includes("FROM stolot"));
    expect(lotCall?.params.qty.value).toBe(48);
    // Cost and taxes count base units too: 48 x 0.50 €, and 10% of 46.08.
    expect(prepared.totcosEuros).toBe(24);
    expect(prepared.taxes.netoCents).toBe(4608);
    expect(prepared.taxes.ivaCents[1]).toBe(461);
  });

  it("defaults a claim that predates the factor to 1, and the contract catches it", async () => {
    const { parent } = fakeParent([
      [{ "": new Date(Date.UTC(2026, 7, 16)) }],
      [{ TARCLI: 1, TIPIVACLI: "N", regiva: "", FORPAG: "", PRIPAG: 1, NUMPAG: 1, CALENV: "", CAL2: "", CODPOSENV: "", TIPPOR: "" }],
      [{ T: "G", POSMAT: 1 }],
      [{ C: "N", A: "G", TPCIVA: 10 }],
      [{ DES: "CERVEZA 33CL", PRECOS: 0.5, T: "G", UNILOT: 24, UNI: "CAJA", CONLOT: true }],
      [{ TIER: 1, LOT: "L48", FECCAD: new Date(Date.UTC(2027, 4, 1)), DISPO: 80, DIASCAD: -300 }],
    ]);

    // An in-flight payload from before the claim RPC learned to send the factor.
    const order = claimedOrder({
      subtotal_cents: 4608,
      items: [
        {
          codart: "1-001",
          qty: 2,
          unit_price_cents: 96,
          line_total_cents: 4608,
          is_weighed: false,
          is_erp_excluded: false,
        },
      ],
    });
    const prepared = await prepareOrder(parent, cfg, order);

    // Nothing is guessed: the factor is 1 and the arithmetic is honest about it,
    // which is exactly what makes the mismatch visible one step later.
    expect(prepared.lines[0].qtyBase).toBe(2);
    expect(prepared.lines[0].lineTotalCents).toBe(192);
    expect(prepared.lines[0].portalLineTotalCents).toBe(4608);
    const { parent: checkParent } = fakeParent([]);
    await expect(
      contractChecks(checkParent, cfg, 501, 3, prepared.lines),
    ).rejects.toThrow(/CONTRATO: SUBTOT/);
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
      [{ DES: "ARROZ", PRECOS: 1, T: "G", UNILOT: 1, UNI: "UNIDAD", CONLOT: true }],
      [{ TIER: 1, LOT: "L1", FECCAD: new Date(Date.UTC(2027, 0, 1)), DISPO: 80, DIASCAD: -300 }],
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
