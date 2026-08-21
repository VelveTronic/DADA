/**
 * The lot ladder's pre-deploy gate: run the SHIPPED `LOT_PICK_SQL`, byte for
 * byte, against a real Wingest database and report what it would pick.
 *
 * Run this BEFORE copying a new `dada-bridge.js` to the ERP server. It answers
 * the two questions a unit test cannot:
 *
 *  (a) **Does the statement COMPILE?** `pedclili` and `stolot` do not share a
 *      collation (Modern_Spanish_CS_AS vs _CI_AS), and on 2026-08-16 that took
 *      order 1006 down with PREFLIGHT_FAILED — at compile time, before a single
 *      row was read. A compile error here would break every line of every
 *      order, so it is proved against the real database rather than argued.
 *  (b) **Does the ladder still rank the way it was designed to?** The histogram
 *      must reproduce the census the tiers were chosen from
 *      (2026-08-21, wgdemo, qty=24, 1,289 lot-controlled articles with stolot
 *      rows in almacén 00001): 714 tier-1, 239 tier-2, 37 tier-3, 32 tier-4 and
 *      267 with no row at all. A deviation means the CASE or an APPLY is wrong,
 *      and it is visible before anything is deployed.
 *
 * It is READ-ONLY: one SELECT per article, no writes, no transaction. It runs
 * one query per article on purpose — that is exactly what the injector does per
 * line, so the timing it reports is the timing the bridge will see.
 *
 * Usage (from the repo root, with the ERP reachable):
 *   WG_SERVER=... WG_PORT=50352 WG_DB=wgdemo WG_USER=dada_bridge WG_PW=... \
 *     pnpm exec tsx scripts/wingest/lot-pick-census.ts [qty]
 *
 * The password is read from the environment and never printed. Point WG_DB at
 * `wg_test` to rehearse against the sandbox first.
 */
import sql from "mssql";
import { LOT_PICK_SQL } from "../../src/bridge/injector";

/** The 2026-08-21 wgdemo census the ladder was designed from, at qty=24. */
const EXPECTED = { "1": 714, "2": 239, "3": 37, "4": 32, none: 267 } as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const qty = Number(process.argv[2] ?? 24);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("qty must be > 0");
  const alm = process.env.WG_ALM?.trim() || "00001";
  const db = required("WG_DB");

  const pool = await sql.connect({
    server: required("WG_SERVER"),
    port: Number(process.env.WG_PORT ?? 50352),
    database: db,
    user: required("WG_USER"),
    password: required("WG_PW"),
    options: { encrypt: true, trustServerCertificate: true },
    requestTimeout: 300_000,
  });

  const ask = async (codart: string) => {
    const request = pool.request();
    request.input("alm", sql.Char(5), alm);
    request.input("codart", sql.VarChar, codart);
    request.input("qty", sql.Float, qty);
    return (await request.query(LOT_PICK_SQL)).recordset;
  };

  // Purpose (a) first, and on its own: one call with a codart that matches
  // nothing compiles the SHIPPED statement before anything else can fail. The
  // article-list query below is this script's own helper, and a failure there
  // must not be mistaken for "the ladder's SQL is broken".
  await ask("__none__");

  // Lot-controlled articles only: `articulo.CONLOT=false` never reaches the
  // pick statement, because `pickLot` answers those with an empty CODLOT
  // before it asks stolot anything.
  //
  // `COLLATE DATABASE_DEFAULT` twice, for two different jobs. On the JOIN it is
  // the 2026-08-16 lesson applied to the one table pairing the bridge itself
  // never makes: `articulo` against `stolot`, two IMPLICIT labels and no rule
  // to pick between them, which is a compile error and not a wrong answer. In
  // the SELECT list it is not decoration either — `DISTINCT` deduplicates under
  // the projected expression's collation, so the label is what keeps the
  // article list from folding (or not folding) two codarts by whatever
  // collation `stolot` happens to carry.
  const listRequest = pool.request();
  listRequest.input("alm", sql.Char(5), alm);
  const list = await listRequest.query(
    `SELECT DISTINCT RTRIM(s.CODART) COLLATE DATABASE_DEFAULT AS CODART
       FROM stolot s
       JOIN articulo a ON a.CODART=s.CODART COLLATE DATABASE_DEFAULT AND a.CONLOT=1
      WHERE s.CODALM=@alm`,
  );
  const articles: string[] = list.recordset.map(
    (row: { CODART: string }) => row.CODART,
  );

  const histogram: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    none: 0,
  };
  const expiredSamples: string[] = [];
  for (const codart of articles) {
    const rows = await ask(codart);
    const row = rows[0];
    if (!row) {
      histogram.none++;
      continue;
    }
    histogram[String(row.TIER)]++;
    if (Number(row.TIER) >= 3 && expiredSamples.length < 10) {
      expiredSamples.push(
        `${codart}:${String(row.LOT).trim()}:${row.DIASCAD}d:${row.DISPO}`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        db,
        alm,
        qty,
        articles: articles.length,
        histogram,
        expected: qty === 24 ? EXPECTED : null,
        matchesCensus:
          qty === 24 &&
          (Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]).every(
            (key) => histogram[key] === EXPECTED[key],
          ),
        // What the expired rungs would rescue, for the flag decision.
        expiredSamples,
      },
      null,
      2,
    ),
  );
  await pool.close();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
