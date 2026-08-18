/**
 * The albarán job: notice that Wingest has turned one of our pedidos into a
 * delivery note, and write that number back to the portal order.
 *
 * The direction matters. Nothing here writes to the ERP — the conversion is a
 * human pressing "Albarán" in the Wingest UI, on their own schedule, and this
 * job only reads `albfacca` and reports what it finds. The portal order moves
 * `injected` → `albaran`, which is what the customer sees as 已出单.
 *
 * The query is driven by the PORTAL's list of injected orders rather than by
 * scanning `albfacca` for recent rows: the portal knows exactly which NUMPEDs it
 * is waiting for (a handful), and the ERP's albarán table holds every delivery
 * note the company has ever issued.
 */
import type { BridgeConfig } from "../config";
import {
  P,
  applyParams,
  toNumber,
  toText,
  type ParamMap,
  type SqlParent,
} from "../injector";
import type { Logger } from "../log";
import type { BridgeSupabase, InjectedOrderRef } from "../supabase";
import type { JobCounts, JobResult } from "./shared";

/**
 * NUMPEDs per query. SQL Server's hard ceiling on parameters is 2100 and its
 * plan cache would hold one plan per distinct list length; 200 keeps both far
 * away and still asks once for any realistic backlog.
 */
export const ALBARAN_CHUNK_SIZE = 200;

export interface AlbaranDeps {
  cfg: BridgeConfig;
  api: Pick<
    BridgeSupabase,
    "listInjected" | "backfillOrderIdentity" | "markAlbaran"
  >;
  log: Logger;
  connect: (cfg: BridgeConfig) => Promise<SqlParent & { close(): Promise<unknown> }>;
}

/**
 * `injected` counts DISTINCT (CAN,EJE,NUMPED) identities, not portal orders — it
 * is the size of the set this run asked `albfacca` about. `matched` counts the
 * complete identities that came back with a usable albarán, and can never exceed
 * `injected`: a pedido is removed from its scoped waiting set the moment it
 * matches, so partial deliveries count once while equal NUMPEDs in two years do
 * not collide.
 *
 * `marked` counts ORDER rows confirmed by `bridge_mark_albaran`, and moves in
 * BOTH directions away from `matched`:
 *
 * - **LESS than `matched`** whenever a mark does not land — the RPC returns
 *   false (the order was no longer `injected`: staff cancelled it, or an earlier
 *   run already marked it) or the call throws. Both are logged and neither stops
 *   the run, so `marked < matched` is the ordinary shape of a run with one
 *   problem order in it. `matched - marked` is the number of pedidos whose
 *   albarán the portal has NOT recorded yet; the next run retries them.
 * - **MORE than `matched`** only if two portal orders somehow share a NUMPED, in
 *   which case one match marks both — the collision this job warns about rather
 *   than hides.
 *
 * They are equal in a clean run, which is the only reason both are printed.
 */
export interface AlbaranTally {
  injected: number;
  matched: number;
  marked: number;
  /** Injected portal rows missing any part of their persisted ERP identity. */
  failed: number;
}

export function emptyAlbaranTally(): AlbaranTally {
  return { injected: 0, matched: 0, marked: 0, failed: 0 };
}

/** The summary line's fields, in the order the plan names them. */
export function albaranCounts(tally: AlbaranTally): JobCounts {
  return {
    injected: tally.injected,
    matched: tally.matched,
    marked: tally.marked,
    failed: tally.failed,
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * `NUMPED IN (@p0, @p1, ...)` — the list length is the ONLY thing that varies.
 *
 * The values are parameters, never text. An interpolated IN list is the classic
 * place a bridge stops being read-only, and these numbers come back over HTTPS
 * from a table the ERP does not own; `@p0..@pN` makes their content irrelevant
 * to how the statement parses.
 */
export function buildAlbaranQuery(numpedCount: number): string {
  if (!Number.isInteger(numpedCount) || numpedCount < 1) {
    throw new Error(`buildAlbaranQuery needs at least one NUMPED, got ${numpedCount}`);
  }
  const placeholders = Array.from({ length: numpedCount }, (_, i) => `@p${i}`).join(", ");
  return (
    // ASSUMPTION, deliberate: the albarán is issued under the SAME canal as the
    // pedido. DADA operates one canal ('B'), and every albarán in the sandbox
    // matched its pedido's CAN — so pinning it keeps NUMPED unambiguous, which
    // is the whole point of a CAN/EJE/NUMPED namespace.
    //
    // The failure mode if that ever stops being true: an albarán issued under a
    // different canal never matches, this job reports the order as unmatched
    // run after run, and the portal leaves it in `injected` forever. There is no
    // wrong NUMALB and no data damage — just a stale status. `docs/
    // bridge-runbook.md` §⑧ tells the operator to check `albfacca.CAN` first
    // when an injected order never advances.
    "SELECT CAN, EJEALB, NUMPED, NUMALB FROM albfacca " +
    `WHERE CAN=@can AND EJEALB>=@eje AND EJEALB<=@nextEje AND NUMPED IN (${placeholders}) ` +
    // ORDER BY is what makes "the first row wins" mean "the LOWEST albarán
    // wins": one pedido delivered in two goes has two albfacca rows, and the
    // portal shows a single NUMALB. The first one issued is the one the customer
    // was told about, and an unordered recordset would pick whichever the query
    // plan happened to emit first — a number that could change between runs.
    "ORDER BY NUMPED, EJEALB, NUMALB"
  );
}

export function buildAlbaranParams(
  numpeds: readonly number[],
  identity: Pick<ErpIdentityGroup, "erpCan" | "erpEje">,
): ParamMap {
  const params: ParamMap = {
    can: P.text(identity.erpCan),
    eje: P.int(identity.erpEje),
    nextEje: P.int(identity.erpEje + 1),
  };
  numpeds.forEach((numped, index) => {
    params[`p${index}`] = P.int(numped);
  });
  return params;
}

export function buildHistoricalPedidoQuery(): string {
  return (
    "SELECT TOP 1 CAN, EJE, NUMPED FROM (" +
    "SELECT CAN, EJE, NUMPED, RTRIM(NUMPEDCLI) AS NUMPEDCLI FROM pedclica " +
    "UNION ALL " +
    "SELECT CAN, EJE, NUMPED, RTRIM(NUMPEDCLI) AS NUMPEDCLI FROM pedclicah" +
    ") z WHERE z.NUMPED=@numped AND z.NUMPEDCLI=@ref " +
    "ORDER BY z.EJE DESC, z.NUMPED DESC"
  );
}

export function buildHistoricalPedidoParams(input: {
  orderNumber: number;
  numped: number;
}): ParamMap {
  return {
    numped: P.int(input.numped),
    ref: P.text(`PORTAL-${input.orderNumber}`),
  };
}

export function readHistoricalPedidoRow(row: Record<string, unknown>): {
  can: string | null;
  eje: number | null;
  numped: number | null;
} {
  const can = toText(row.CAN).trim().toUpperCase();
  return {
    can: can.length > 0 ? can : null,
    eje: toNumber(row.EJE),
    numped: toNumber(row.NUMPED),
  };
}

/**
 * One saved CAN/EJE scope and its NUMPED → portal-order index.
 *
 * An array of ids rather than one id because the map is built from data, and
 * data surprises: two portal orders should never carry the same NUMPED (the
 * injector's dedup key is per order_number), but if they ever did, marking only
 * one of them would leave the other silently stuck in `injected` forever.
 *
 * A row missing CAN, EJE or NUMPED is a portal bug — `bridge_mark_injected`
 * writes the status and the complete identity together — so it is counted and
 * reported, not skipped in silence.
 */
export interface ErpIdentityGroup {
  erpCan: string;
  erpEje: number;
  byNumped: Map<number, string[]>;
}

export function indexByErpIdentity(orders: readonly InjectedOrderRef[]): {
  groups: ErpIdentityGroup[];
  withoutIdentity: string[];
} {
  const byCan = new Map<string, Map<number, ErpIdentityGroup>>();
  const withoutIdentity: string[] = [];
  for (const order of orders) {
    if (
      typeof order.erpCan !== "string" ||
      order.erpCan.length < 1 ||
      order.erpCan.length > 2 ||
      order.erpCan !== order.erpCan.trim() ||
      order.erpCan !== order.erpCan.toUpperCase() ||
      !Number.isInteger(order.erpEje) ||
      Number(order.erpEje) < 1 ||
      !Number.isInteger(order.numped) ||
      Number(order.numped) < 1
    ) {
      withoutIdentity.push(order.id);
      continue;
    }

    let byEje = byCan.get(order.erpCan);
    if (!byEje) {
      byEje = new Map();
      byCan.set(order.erpCan, byEje);
    }
    const erpEje = order.erpEje as number;
    const numped = order.numped as number;
    let group = byEje.get(erpEje);
    if (!group) {
      group = { erpCan: order.erpCan, erpEje, byNumped: new Map() };
      byEje.set(erpEje, group);
    }
    const existing = group.byNumped.get(numped);
    if (existing) existing.push(order.id);
    else group.byNumped.set(numped, [order.id]);
  }
  return {
    groups: [...byCan.values()].flatMap((byEje) => [...byEje.values()]),
    withoutIdentity,
  };
}

function hasCompleteErpIdentity(order: InjectedOrderRef): boolean {
  return (
    typeof order.erpCan === "string" &&
    order.erpCan.length >= 1 &&
    order.erpCan.length <= 2 &&
    order.erpCan === order.erpCan.trim() &&
    order.erpCan === order.erpCan.toUpperCase() &&
    Number.isInteger(order.erpEje) &&
    Number(order.erpEje) >= 1 &&
    Number(order.erpEje) <= 9_999 &&
    Number.isInteger(order.numped) &&
    Number(order.numped) >= 1
  );
}

async function hydrateHistoricalPedidoIdentity(
  pool: SqlParent,
  api: Pick<BridgeSupabase, "backfillOrderIdentity">,
  order: InjectedOrderRef,
  log: Logger,
): Promise<void> {
  if (hasCompleteErpIdentity(order) || order.numped === null) return;

  try {
    const request = pool.request();
    applyParams(
      request,
      buildHistoricalPedidoParams({
        orderNumber: order.orderNumber,
        numped: order.numped,
      }),
    );
    const result = await request.query<Record<string, unknown>>(
      buildHistoricalPedidoQuery(),
    );
    const row = result.recordset?.[0];
    if (!row) {
      log.error("historical Pedido identity was not found in Wingest", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        numped: order.numped,
        stage: "historical_identity",
      });
      return;
    }

    const identity = readHistoricalPedidoRow(row);
    if (
      identity.can === null ||
      identity.can.length > 2 ||
      identity.eje === null ||
      identity.eje < 1 ||
      identity.eje > 9_999 ||
      identity.numped !== order.numped
    ) {
      log.error("historical Pedido identity was invalid", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        numped: order.numped,
        can: identity.can,
        eje: identity.eje,
        returnedNumped: identity.numped,
        stage: "historical_identity",
      });
      return;
    }

    const marked = await api.backfillOrderIdentity(
      order.id,
      identity.can,
      identity.eje,
      identity.numped,
    );
    if (!marked) {
      log.error("historical Pedido identity backfill returned false", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        can: identity.can,
        eje: identity.eje,
        numped: identity.numped,
        stage: "historical_identity_backfill",
      });
      return;
    }

    order.erpCan = identity.can;
    order.erpEje = identity.eje;
  } catch (error) {
    log.logError(error, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      numped: order.numped,
      stage: "historical_identity",
    });
  }
}

/** One `albfacca` row, coerced out of whatever the driver handed back. */
export function readAlbaranRow(row: Record<string, unknown>): {
  can: string | null;
  eje: number | null;
  numped: number | null;
  numalb: number | null;
} {
  const can = toText(row.CAN).trim().toUpperCase();
  return {
    can: can.length > 0 ? can : null,
    eje: toNumber(row.EJEALB),
    numped: toNumber(row.NUMPED),
    numalb: toNumber(row.NUMALB),
  };
}

export async function runAlbaranSync(deps: AlbaranDeps): Promise<JobResult> {
  const { cfg, api, log, connect } = deps;
  const tally = emptyAlbaranTally();

  const injected = await api.listInjected();
  if (injected.length === 0) {
    log.info("nothing awaiting an albarán");
    return { ok: true, counts: albaranCounts(tally) };
  }

  const pool = await connect(cfg);
  try {
    for (const order of injected) {
      await hydrateHistoricalPedidoIdentity(pool, api, order, log);
    }

    const { groups, withoutIdentity } = indexByErpIdentity(injected);
    tally.failed = withoutIdentity.length;
    if (withoutIdentity.length) {
      log.error("injected orders without a complete ERP identity", {
        count: withoutIdentity.length,
        orderIds: withoutIdentity.slice(0, 10).join(","),
      });
    }
    tally.injected = groups.reduce((sum, group) => sum + group.byNumped.size, 0);

    for (const group of groups) {
      const numpeds = [...group.byNumped.keys()];
      for (const batch of chunk(numpeds, ALBARAN_CHUNK_SIZE)) {
        const request = pool.request();
        applyParams(request, buildAlbaranParams(batch, group));
        const result = await request.query<Record<string, unknown>>(
          buildAlbaranQuery(batch.length),
        );

        for (const raw of result.recordset ?? []) {
          const { can: albaranCan, eje: albaranEje, numped, numalb } =
            readAlbaranRow(raw);
          if (numped === null) continue;
          // The query itself is scoped by this saved CAN/EJE. A NUMPED returned
          // here can therefore only match this group's complete identity.
          const orderIds = group.byNumped.get(numped);
          if (!orderIds) continue;
          const identityFields = {
            can: group.erpCan,
            eje: group.erpEje,
            albaranCan,
            albaranEje,
            numped,
          };
          if (
            albaranCan === null ||
            albaranCan.length > 2 ||
            albaranEje === null ||
            albaranEje < 1 ||
            albaranEje > 9_999 ||
            numalb === null ||
            numalb <= 0
          ) {
            log.warn("albfacca row has no usable NUMALB", {
              ...identityFields,
              numalb,
            });
            continue;
          }
          tally.matched++;
          group.byNumped.delete(numped);
          if (orderIds.length > 1) {
            log.warn("several portal orders carry the same ERP identity", {
              ...identityFields,
              orderIds: orderIds.join(","),
            });
          }
          for (const orderId of orderIds) {
            try {
              const marked = await api.markAlbaran(
                orderId,
                albaranCan,
                albaranEje,
                numalb,
              );
              if (marked) {
                tally.marked++;
                log.info("albarán matched", {
                  orderId,
                  ...identityFields,
                  numalb,
                });
              } else {
                log.error("mark_albaran returned false", {
                  orderId,
                  ...identityFields,
                  numalb,
                });
              }
            } catch (error) {
              log.logError(error, {
                orderId,
                ...identityFields,
                numalb,
                stage: "mark_albaran",
              });
            }
          }
        }
      }
    }
  } finally {
    try {
      await pool.close();
    } catch (error) {
      log.logError(error, { stage: "pool_close" });
    }
  }

  return { ok: true, counts: albaranCounts(tally) };
}
