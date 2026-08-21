import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import {
  cancelOrder,
  confirmOrder,
  requeueOrder,
} from "@/app/actions/staff-orders";
import { OrderStatusBadge } from "@/components/order-status-badge";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD, FIELD_SM } from "@/components/ui";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import { formatMadridTime } from "@/lib/bridge-status";
import type { OrderBridgeFailure, QueueTab } from "@/lib/orders";
import {
  formatOrderDate,
  isLineEditResult,
  parseOrderBridgeFailures,
  QUEUE_TABS,
  safeQueueTab,
} from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { readLoggedCount } from "@/lib/shell-counts";
import type { Database } from "@/lib/supabase/database.types";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";
import { LineQtyForm } from "./line-qty-form";
import { QueueRow } from "./queue-row";

export const dynamic = "force-dynamic";

/**
 * The newest N orders of whichever view is selected. Unchanged, and now SAID:
 * the card's footer prints the view's real size beside this number, so a tab
 * holding 214 orders no longer looks like a tab holding 50 (see the note on the
 * footer itself). A numbered pager is a recorded follow-up, not this task.
 */
const PAGE_SIZE = 50;

/**
 * The ceiling on the lines read below — asked for here rather than left to the
 * server, so the number lives beside the reasoning that shapes the query.
 *
 * PostgREST truncates any response at `max_rows` (1000 —
 * `supabase/config.toml:18`, and the same default on the cloud project) whether
 * or not a query asks for a limit, so this IS the bound either way.
 *
 * The arithmetic on THIS page: the queue draws at most `PAGE_SIZE` = 50 orders,
 * so 1000 rows is an average of 20 lines per order — and orders that size are
 * ordinary here, since `create_order` accepts up to 200 lines (TOO_MANY_LINES).
 * Fifty full restaurant orders therefore reach the cap, and what a truncated
 * read looks like on screen is decided by the sort below, not by luck.
 *
 * The `items.length === LINES_LIMIT` detection below holds only while this
 * number EQUALS the server's `max_rows`: lower the cloud cap under it and the
 * response stops at `max_rows` instead, the equality never fires, and the check
 * goes silent rather than loud. Move the two together.
 */
const LINES_LIMIT = 1000;

/**
 * The tab chips, per the mockup's filter row: active is its ink swatch with
 * white letters (the token map's `bg-ink text-white font-semibold`), resting is
 * the house's quiet control.
 *
 * The same three strings `/staff/productos` draws its category chips from
 * (`productos/page.tsx:68-70`), copied rather than imported: they are page-local
 * constants there, and one screen's chip row is not yet shared vocabulary. If
 * A5 or A6 draws a third, that is when it earns a home in `ui.ts`.
 */
const CHIP = "inline-flex h-[30px] items-center rounded-lg px-3 text-[12.5px]";
const CHIP_ON = `${CHIP} bg-ink font-semibold text-white`;
const CHIP_OFF = `${CHIP} border border-border-strong bg-surface text-ink-soft transition-colors hover:border-brand hover:text-brand-ink`;

/**
 * A row action, at the admin's metrics.
 *
 * 30px is not a guess: the note input beside these buttons is `FIELD_SM`
 * (`text-sm` = 20px of line box, `py-1` = 8px, 1px of border top and bottom =
 * 30px), so the controls in a row sit on one baseline strip. The COLOURS below
 * are the shipped semantics and are untouched — 确认 is the accent, 取消 is
 * destructive red, 重新入队 is the amber of the failure box it answers.
 */
const ACTION =
  "inline-flex h-[30px] shrink-0 items-center rounded-lg px-3 text-[12.5px] transition-colors";

/*
 * The two shades this card draws rows with, neither of them a token and both
 * already named on `/staff/productos` (:81-94):
 *
 *  - `#F4F0EC` — the rule BETWEEN rows, lighter than `ADMIN_CARD`'s own edge.
 *  - `#FCFBFA` — the mockup's admin pane wash, used on the row hover.
 */

/**
 * The customer-readable order columns plus the restaurant that placed it.
 *
 * Staff read orders on the SAME authenticated client and the SAME column list:
 * `staff_note` is revoked from authenticated whoever is asking (CLAUDE.md), so
 * a staff page that reached for it would 403 exactly like a customer page.
 * Notes go IN through the RPCs and are read back with service-role tooling.
 */
type QueueOrder = PublicOrder & {
  companies: { name: string; codcli: number | null } | null;
};

/**
 * Exactly the line columns this page renders, off the order's own snapshot —
 * plus the one thing that is deliberately NOT a snapshot.
 *
 * `is_weighed` exists in both places and they mean different things. The line's
 * copy is what the order was placed under and what the bridge sends Wingest; the
 * product's is the rule for what a quantity may look like TODAY, which is what
 * the editor below needs, and what `staff_update_order_line` re-reads for itself.
 * Flagging an article as weighed has to reach the orders already sitting in this
 * queue, so the live flag wins and the snapshot is the fallback for a line whose
 * product row is gone.
 *
 * The two can no longer drift apart on a line anyone has touched: since v2 of
 * the RPC (2026-08-17, after order 1007 stranded the bridge) an accepted edit
 * WRITES the coalesced value back onto the line, so the snapshot always records
 * the terms the quantity beside it was last judged under. Unedited lines keep
 * the value they were placed with, which is why this fallback still has work to
 * do.
 */
type QueueItem = Pick<
  Database["public"]["Tables"]["order_items"]["Row"],
  | "id"
  | "order_id"
  | "codart"
  | "name"
  | "qty"
  | "unit"
  | "units_per_case"
  | "unit_price_cents"
  | "line_total_cents"
  | "is_weighed"
> & { products: { is_weighed: boolean } | null };

/**
 * The three sortable columns, `?orden=` value → orders column. A whitelist
 * OBJECT rather than passing the parameter through: `.order()` takes a column
 * name, and a user-editable string reaching it would be an open sort oracle.
 * `fecha` is the default and matches what the queue always did (newest first).
 */
const QUEUE_SORTS = {
  num: "order_number",
  fecha: "created_at",
  importe: "subtotal_cents",
} as const;
type QueueSort = keyof typeof QUEUE_SORTS;

export default async function StaffOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{
    estado?: string;
    rpcResult?: string;
    lineResult?: string;
    q?: string;
    orden?: string;
    dir?: string;
  }>;
}) {
  const { locale } = await params;
  const {
    estado: rawEstado,
    rpcResult: rawResult,
    lineResult: rawLineResult,
    q: rawQ,
    orden: rawOrden,
    dir: rawDir,
  } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/pedidos`);
  const { supabase, pendingStaff } = await beginStaff(locale);
  const t = await getTranslations("staff");
  // The money labels are the cart's: reused rather than duplicated into the
  // staff namespace. (The order-number/date words left with the table rework —
  // the column headers name those cells now.)
  const tCart = await getTranslations("cart");
  // …and the 称重 badge is the catalogue's, for the same reason.
  const tCatalog = await getTranslations("catalog");

  // Both query strings are user-editable. The tab reaches `.eq("status", …)`,
  // so it is validated before it is used, not after.
  const tab = safeQueueTab(rawEstado);
  const rpcResult =
    rawResult === "ok" || rawResult === "wrong-state" || rawResult === "error"
      ? rawResult
      : null;
  // The line editor answers on its own parameter rather than sharing `rpcResult`:
  // its vocabulary is six codes wide (a quantity can be refused four ways), and a
  // redirect only ever sets one of the two.
  const lineResult =
    typeof rawLineResult === "string" && isLineEditResult(rawLineResult)
      ? rawLineResult
      : null;

  // The owner's third-pass additions (2026-08-20): find and sort. All three
  // parameters are user-editable and all three are validated the tab's way —
  // before use, against a whitelist or a sanitizer, never after.
  const q = sanitizeSearch(rawQ ?? "");
  const sort: QueueSort =
    rawOrden === "num" || rawOrden === "importe" ? rawOrden : "fecha";
  const dir: "asc" | "desc" = rawDir === "asc" ? "asc" : "desc";
  // All digits = an order number; anything else searches the restaurant. The
  // length cap keeps a 30-digit paste from overflowing the int the eq targets.
  const numericQ = /^\d{1,9}$/.test(q) ? Number(q) : null;

  let query = supabase
    .from("orders")
    // The `!inner` embed exists ONLY on a name search: PostgREST can filter a
    // parent by an embedded column just when the join is inner. It is not the
    // default because `!inner` also silently DROPS any order whose company row
    // vanished — impossible today (`company_id` is `not null references`), but
    // the plain embed answers such a row with `companies: null` instead of
    // hiding it, and a queue must not hide orders to be robust against a
    // hypothetical.
    .select(
      q && numericQ === null
        ? `${PUBLIC_ORDER_COLUMNS}, companies:company_id!inner(name, codcli)`
        : `${PUBLIC_ORDER_COLUMNS}, companies:company_id(name, codcli)`,
    )
    .order(QUEUE_SORTS[sort], { ascending: dir === "asc" })
    .limit(PAGE_SIZE);
  // The tiebreak keeps 金额-sorted rows stable between visits: two orders of
  // the same subtotal keep their relative place instead of swapping on each
  // render. Redundant when the primary IS the number, so skipped there.
  if (sort !== "num") {
    query = query.order("order_number", { ascending: dir === "asc" });
  }
  // `all` is the absence of a filter, which is why it is not a status.
  if (tab !== "all") query = query.eq("status", tab);
  if (numericQ !== null) query = query.eq("order_number", numericQ);
  else if (q) query = query.ilike("companies.name", `%${q}%`);

  /**
   * One chip's count. `head: true` so not a single row comes back, only the
   * `Content-Range` — the idiom the shell reads its backlog with. The select
   * list names one real column: `orders` is column-revoked (`staff_note`) and a
   * `*` there 403s the query.
   *
   * `all` is the absence of a filter here exactly as it is on the queue query
   * above, which is what makes the 全部 chip's figure the size of the whole
   * table rather than the sum of the three tabs beside it (`processing`,
   * `injected`, `albaran` and `cancelled` have no tab of their own).
   *
   * That unfiltered one is also the page's ONE unbounded COUNT: the three
   * status counts ride the partial index `orders_open`
   * (`20260817100000_bridge_failure_recovery.sql:89-90`, which covers exactly
   * `submitted`/`confirmed`/`processing`/`bridge_failed`), while 全部 has no
   * predicate to ride anything with and scans the whole table — so it is the
   * figure that grows with `orders` forever. At the scale where that starts to
   * show, the swap is `count: "estimated"` on this one target, not a new index.
   *
   * `submitted` and `bridge_failed` are counted TWICE per request: `StaffShell`
   * reads the same two predicates for the sidebar's 待办 block and its 订单
   * badge (`staff-shell.tsx:132-149`). Same request, separate round — the shell
   * renders after this page's reads have resolved — so the badge and the chip
   * can differ by the milliseconds between them. Unifying them behind one
   * `cache()`d read is a recorded follow-up, not this round.
   */
  const countQuery = (target: QueueTab) => {
    const counted = supabase
      .from("orders")
      .select("id", { count: "exact", head: true });
    return target === "all" ? counted : counted.eq("status", target);
  };

  // The queue is built from `?estado=` alone, so it needs nothing the guard is
  // fetching and goes out beside it. This is the SESSION client: `orders_read`
  // opens the whole table to staff and to nobody else, so a caller who turns out
  // not to be staff reads their own restaurant's orders at worst — and is
  // redirected before a single row is rendered.
  //
  // The four chip counts ride in the same round, under one step: they are the
  // same session client, the same table and the same RLS as the queue query, so
  // making them wait for it would buy nothing but a second round trip.
  const [staffUser, { data, error }, tabCountResults] = await Promise.all([
    finishStaff(pendingStaff, locale),
    perf.step("orders", query),
    perf.step(
      "tabCounts",
      Promise.all([
        countQuery("submitted"),
        countQuery("confirmed"),
        countQuery("bridge_failed"),
        countQuery("all"),
      ]),
    ),
  ]);
  if (error) console.error("staff orders query:", error);
  const orders: QueueOrder[] = data ?? [];

  const [submittedCount, confirmedCount, failedCount, allCount] =
    tabCountResults;
  // Read and logged by the shared half (`lib/shell-counts.ts`), which prints
  // `staff queue <tab> count (status <n>)` and names BOTH failure shapes —
  // including the quiet one, a `head: true` request whose response carries no
  // error JSON to parse. The `QueueTab` keys below are the log's `name`: the
  // parameter is `string` and the union is a subtype of it, so the emitted line
  // is the tab's own id and the record's keys stay checked against `QueueTab`.
  // `null` renders as the chip's LABEL with no number — never as 0. A count
  // that did not arrive must not be able to tell a staff member there is
  // nothing to confirm.
  const tabCounts: Record<QueueTab, number | null> = {
    submitted: readLoggedCount("staff queue", "submitted", submittedCount),
    confirmed: readLoggedCount("staff queue", "confirmed", confirmedCount),
    bridge_failed: readLoggedCount("staff queue", "bridge_failed", failedCount),
    all: readLoggedCount("staff queue", "all", allCount),
  };
  /** The chip figure of the view on screen — and the footer's total. */
  const activeCount = tabCounts[tab];

  // The two reads that genuinely queue: both filter on ids that only exist once
  // `orders` has come back, so neither could have gone out in the round above.
  // Neither depends on the OTHER, though — both filters are derived from the
  // same array, synchronously, right here — so they go out together and this is
  // ONE second round trip, not two. `perf.step` puts a query on the wire the
  // moment it is handed one (see the module note in `lib/perf.ts`), so the two
  // are already in flight before `Promise.all` is entered; the `Promise.all` is
  // what stops the second from waiting on the first. Each side keeps its own
  // step label and its own error handling, and an empty filter list short-
  // circuits to `null` rather than asking the server for `in ()`.
  const orderIds = orders.map((order) => order.id);
  // Failure diagnostics are deliberately NOT columns in the ordinary orders
  // query. `authenticated` includes customers too, so granting those columns
  // would let a restaurant read raw ERP/SQL errors from its own order. This
  // bounded RPC re-checks active staff and returns only the ids on this page.
  const failedOrderIds = orders
    .filter((order) => order.status === "bridge_failed")
    .map((order) => order.id);

  const [itemResult, failureResult] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve(null)
      : perf.step(
          "orderItems",
          supabase
            .from("order_items")
            // One string literal, never a concatenation: supabase-js types the
            // row from the literal, and `"a, " + "b"` widens to `string` and
            // loses it. The embed is the product's live `is_weighed`, joined
            // through the line's own FK column exactly as the orders query
            // joins `companies` — one more join on the same round trip, rather
            // than a second query per card.
            .select(
              "id, order_id, codart, name, qty, unit, units_per_case, unit_price_cents, line_total_cents, is_weighed, products:product_id(is_weighed)",
            )
            .in("order_id", orderIds)
            // `order_id` FIRST, and the explicit `LINES_LIMIT`, are ONE
            // decision: what a TRUNCATED read is allowed to look like on this
            // screen. The cap applies whether or not it is asked for (see
            // `LINES_LIMIT`), and fifty orders averaging twenty lines already
            // reach it.
            //
            // Under a global `sort_order` the rows that fall off the end are
            // the deepest lines of EVERY order at once: fifty cards each
            // quietly missing their tail, each one wrong, and the totals under
            // them — which are the ORDER's own `subtotal_cents`, not a sum of
            // what is drawn — still right, so nothing on screen disagrees with
            // anything. Grouping by `order_id` first makes the cut fall BETWEEN
            // orders instead: every order before it carries all its lines, at
            // most ONE straddles the boundary, and the rest have none at all.
            // The trade is that `order_id` is a uuid, so WHICH orders end up
            // past the cut is arbitrary rather than the oldest — acceptable
            // because an order with no lines at all is the loud case, not the
            // quiet one (see the log below). The secondary `sort_order` keeps
            // each order's own lines in the order the customer built them,
            // which is the order the ERP receives them in.
            .order("order_id", { ascending: true })
            .order("sort_order", { ascending: true })
            .limit(LINES_LIMIT),
        ),
    failedOrderIds.length === 0
      ? Promise.resolve(null)
      : perf.step(
          "bridgeFailures",
          supabase.rpc("staff_get_order_bridge_failures", {
            p_order_ids: failedOrderIds,
          }),
        ),
  ]);

  let items: QueueItem[] = [];
  if (itemResult) {
    if (itemResult.error)
      console.error("staff order items query:", itemResult.error);
    items = itemResult.data ?? [];
    // The customer's version of this read logs nothing here, and that is the
    // right call THERE: a card whose lines were cut renders the documented
    // no-counts state (`hasLines` in `order-card.tsx:99`), so the screen itself
    // says it does not know. This page now takes the SAME position, in the same
    // shape: the `<details>` block below is drawn only when the order has lines,
    // because 明细（0 项）for an order that cannot legally have zero lines
    // (`create_order` refuses EMPTY_ORDER —
    // `20260816161500_bridge_caja_units.sql:203`) is not a degraded summary, it
    // is a false statement in front of the staff member about to confirm it.
    // That covers BOTH ways this array can come back short — a truncated read
    // and a query error that leaves it empty — so what the screen loses is the
    // line count, never the truth. The count being WITHHELD is not itself
    // visible, which is why the log below still has work to do: it is the only
    // place the reason is recorded.
    if (items.length === LINES_LIMIT) {
      console.error(
        `staff order items query: ${LINES_LIMIT} rows for ${orderIds.length} orders — the read may be truncated and trailing orders may be missing lines`,
      );
    }
  }

  const failuresByOrder = new Map<string, OrderBridgeFailure>();
  if (failureResult) {
    if (failureResult.error)
      console.error("staff bridge failures query:", failureResult.error);
    for (const failure of parseOrderBridgeFailures(failureResult.data)) {
      // The status comes from the same RPC snapshot as the sensitive fields.
      // A concurrent requeue may have moved the row since the orders query; in
      // that case do not present its historical error as a current terminal one.
      if (failure.status === "bridge_failed") {
        failuresByOrder.set(failure.orderId, failure);
      }
    }
  }
  perf.end();

  const linesByOrder = new Map<string, QueueItem[]>();
  for (const item of items) {
    const lines = linesByOrder.get(item.order_id);
    if (lines) lines.push(item);
    else linesByOrder.set(item.order_id, [item]);
  }

  // A tab switch drops `?rpcResult`: the banner belongs to the click that
  // produced it, not to the next view the staff member opens. The search and
  // the sort SURVIVE both kinds of navigation — a staff member narrowing to
  // one restaurant expects the narrowing to hold while they check its tabs —
  // which is why every link on this screen is built by the one helper.
  const queueHref = (over: {
    estado?: QueueTab;
    q?: string;
    orden?: QueueSort;
    dir?: "asc" | "desc";
  }) => {
    const sp = new URLSearchParams();
    const estado = over.estado ?? tab;
    const qq = over.q ?? q;
    const orden = over.orden ?? sort;
    const dd = over.dir ?? dir;
    if (estado !== "submitted") sp.set("estado", estado);
    if (qq) sp.set("q", qq);
    if (orden !== "fecha") sp.set("orden", orden);
    if (dd !== "desc") sp.set("dir", dd);
    const s = sp.toString();
    return `/${locale}/staff/pedidos${s ? `?${s}` : ""}`;
  };
  const tabHref = (target: QueueTab) => queueHref({ estado: target });
  // A header click: first press sorts this column newest/biggest first, the
  // second flips it — and pressing a DIFFERENT header starts that column at
  // descending again rather than inheriting the old direction.
  const sortHref = (target: QueueSort) =>
    queueHref({
      orden: target,
      dir: sort === target && dir === "desc" ? "asc" : "desc",
    });

  const tabLabel: Record<QueueTab, string> = {
    submitted: t("tabSubmitted"),
    confirmed: t("tabConfirmed"),
    bridge_failed: t("tabBridgeFailed"),
    all: t("tabAll"),
  };

  return (
    <StaffShell
      locale={locale}
      title={t("ordersQueue")}
      breadcrumb={t("nav.orders")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      {/* The mockup's sub-line, saying what this queue actually is. Its own
          version — 客户提交需求单 → 商家报价 → 客户确认 → 发货 — describes a
          quoting product that does not exist (decision 1); what the four words
          below name is the real machine: the restaurant submits, staff confirm,
          the bridge injects the order into Wingest, the ERP answers with an
          albarán. The mockup's two header buttons (导出 Excel, 代客下单) have no
          backend and are OUT (decision 3). */}
      <p className="mt-2 text-[13px] text-muted">{t("queueFlow")}</p>

      {rpcResult && (
        <p
          role={rpcResult === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            rpcResult === "ok"
              ? "bg-green-50 text-green-800"
              : rpcResult === "wrong-state"
                ? "bg-amber-50 text-amber-800"
                : "bg-red-50 text-red-700"
          }`}
        >
          {/* `false` from either RPC means the order had already moved on —
              someone else got there first. It is reported, never assumed away. */}
          {rpcResult === "ok"
            ? t("rpcOk")
            : rpcResult === "wrong-state"
              ? t("rpcWrongState")
              : t("rpcFailed")}
        </p>
      )}

      {lineResult && (
        <p
          role={lineResult === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            lineResult === "ok"
              ? "bg-green-50 text-green-800"
              : // The order moved on under the staff member's feet. Amber, like
                // the transitions' own version of the same news: nothing broke,
                // and nothing was written either.
                lineResult === "WRONG_STATE"
                ? "bg-amber-50 text-amber-800"
                : "bg-red-50 text-red-700"
          }`}
        >
          {t(`lineResults.${lineResult}`)}
        </p>
      )}

      {/* The mockup's filter chips, in place of the underline strip this page
          shipped with. Same four links, same `?estado=`, same `QUEUE_TABS` —
          what is new is the figure on each one: the size of the view it opens,
          counted for real. A chip whose count did not arrive draws its label
          alone; it never draws 0. The mockup's search box and date range beside
          them are unbuilt features and are OUT (decision 3). */}
      {/* Still a `<nav>`, as the underline strip was: four links that switch
          the view. It is named with the queue's own title — the one landmark on
          this page that would otherwise be anonymous, and no new vocabulary is
          invented to say what it switches. */}
      <nav
        aria-label={t("ordersQueue")}
        className="mt-5 flex flex-wrap items-center gap-2.5"
      >
        {QUEUE_TABS.map((target) => {
          const count = tabCounts[target];
          return (
            <Link
              key={target}
              href={tabHref(target)}
              aria-current={tab === target ? "page" : undefined}
              className={tab === target ? CHIP_ON : CHIP_OFF}
            >
              {tabLabel[target]}
              {count !== null && (
                <span className="ml-1.5 font-num tabular-nums">{count}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Find, above the table it narrows (owner, third pass): all digits is
          an order number, anything else matches the restaurant. A GET form —
          the queue is server-first, and the URL carrying the search is what
          lets the tabs and the sort survive it (`queueHref`). The hidden
          fields are the rest of the current view: a form submits ONLY its own
          fields, so without them pressing 搜索 would silently reset the tab
          and the sort. */}
      <form method="get" className="mt-4 flex flex-wrap items-center gap-2">
        {tab !== "submitted" && (
          <input type="hidden" name="estado" value={tab} />
        )}
        {sort !== "fecha" && <input type="hidden" name="orden" value={sort} />}
        {dir !== "desc" && <input type="hidden" name="dir" value={dir} />}
        <input
          name="q"
          defaultValue={q}
          aria-label={t("searchQueue")}
          placeholder={t("searchQueue")}
          className={`h-9 w-72 max-w-full ${FIELD_SM}`}
        />
        <button
          type="submit"
          className={`h-9 rounded-lg border border-border-strong bg-surface px-3.5 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:text-brand-ink`}
        >
          {t("searchGo")}
        </button>
        {q && (
          <Link
            href={queueHref({ q: "" })}
            className="text-[12.5px] text-brand-ink underline underline-offset-4"
          >
            {t("searchClear")}
          </Link>
        )}
      </form>

      {orders.length === 0 ? (
        <p className={`${ADMIN_CARD} mt-[18px] p-10 text-center text-muted`}>
          {q ? t("noSearchResults") : t("noOrders")}
        </p>
      ) : (
        /* `ADMIN_CARD` on the outer wrapper, the mockup's own table inside —
           the owner's third pass turned the card list into a real `<table>`:
           a `<thead>` names the columns (three of them sort), cells align by
           column instead of by fixed guess-width tracks, and the footer sits
           in a `<tfoot>` of the same table. `overflow-x-auto` on its own
           wrapper: the drawer-width fallback is a sideways scroll INSIDE the
           card, never a page that scrolls sideways. */
        <div className={`${ADMIN_CARD} mt-[18px] overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11.5px] text-ink-soft">
                  <th
                    className="py-2.5 pl-[18px] pr-3 font-medium whitespace-nowrap"
                    aria-sort={
                      sort === "num"
                        ? dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <Link
                      href={sortHref("num")}
                      className="transition-colors hover:text-brand-ink"
                    >
                      {t("colNumber")}
                      {sort === "num" && (dir === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium whitespace-nowrap"
                    aria-sort={
                      sort === "fecha"
                        ? dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <Link
                      href={sortHref("fecha")}
                      className="transition-colors hover:text-brand-ink"
                    >
                      {t("colDate")}
                      {sort === "fecha" && (dir === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                  <th className="px-3 py-2.5 font-medium">{t("colClient")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("lines")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("print.link")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("colStatus")}</th>
                  <th
                    className="py-2.5 pl-3 pr-[18px] text-right font-medium whitespace-nowrap"
                    aria-sort={
                      sort === "importe"
                        ? dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <Link
                      href={sortHref("importe")}
                      className="transition-colors hover:text-brand-ink"
                    >
                      {t("colAmount")}
                      {sort === "importe" && (dir === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                </tr>
              </thead>
              <tbody>
            {orders.map((order) => {
              const lines = linesByOrder.get(order.id) ?? [];
              const bridgeFailure = failuresByOrder.get(order.id);
              // `staff_confirm_order` updates `where status = 'submitted'`, so on
              // any other state its button could only ever come back false. The
              // queue shows the order and leaves out the control that cannot work.
              const confirmable = order.status === "submitted";
              // `staff_cancel_order` also accepts `bridge_failed`: an order the
              // ERP will never take is a dead end otherwise, since requeue only
              // sends it back to the same refusal.
              const cancellable =
                confirmable || order.status === "bridge_failed";
              // The quantity boxes belong to the 待确认 view and nowhere else. A
              // submitted order is reachable from 全部 too, and an editable field
              // there would be an invitation to change a pedido somebody opened
              // the tab to READ. `staff_update_order_line` would accept it; this
              // page does not offer it.
              const editable = confirmable && tab === "submitted";
              /**
               * The second line under the restaurant's name, in the mockup's
               * rhythm — its own is `{门店} · {联系人}` and ours carries the
               * things staff actually match against Wingest: the ERP customer
               * number first, then the delivery date and the two ERP document
               * numbers the bridge writes back, each when the order has one.
               *
               * There is no 联系人 to print: `companies` records a name, a CIF,
               * a phone and an address and no contact PERSON at all
               * (`0001_core.sql:5-18`), which is why the plan's A4 OUT list
               * names it outright — "联系人 (codcli is the real second line)"
               * (`docs/superpowers/plans/2026-08-19-14-staff-admin-redesign.md`,
               * Task A4, :94) — for the same reason decision 3 gives the rest
               * of the not-recorded family, 渠道 among them.
               *
               * ONE joined string rather than a row of flex items: the parts
               * then wrap at their own spaces on a 390px drawer instead of
               * breaking into a column, and the `·` that used to prefix the
               * codcli beside the company name is doing the same separating job
               * one line down — with nothing before it, a leading one would just
               * be a stray mark.
               */
              const meta = [
                order.companies?.codcli != null
                  ? String(order.companies.codcli)
                  : null,
                // The delivery date is deliberately NOT here any more — the
                // owner cut it from the queue row (2026-08-20) to buy the line
                // back its width. It is not lost: the customer's own order
                // card still shows it, and the bridge writes it into the
                // pedido's FECENT.
                // The ERP identifiers in the shop's own vocabulary — the
                // owner's wording (2026-08-20), the SAME in both locales:
                // staff call the pedido number "Wingest" and the delivery
                // note "albarán" whichever language the UI is in, so these
                // are staff keys, not the customer's orders.erpOrder pair.
                order.numped != null
                  ? t("wingestNo", { n: order.numped })
                  : null,
                order.numalb != null
                  ? t("albaran", { n: order.numalb })
                  : null,
              ].filter((part): part is string => part !== null);
              /**
               * The fold behind the row's 明细 toggle. The count lives on that
               * toggle, which is why the mockup's 种类 column is not on the row
               * — the plan's A4 OUT list settles both of that pair ("种类/件数
               * columns (line count lives on the details summary; a cajas+kg
               * sum would lie)").
               *
               * And NO lines, NO toggle — the same position `order-card.tsx`
               * takes for the customer: an order always HAS lines
               * (`create_order` refuses EMPTY_ORDER), so an empty array is
               * this page's line read having come back short, and 明细（0 项）
               * would be a false statement about a real order. The count is
               * WITHHELD instead of printed wrong, on both paths that can
               * produce it — the exactly-1000 truncation and a plain query
               * error — and the row keeps everything else it says. The reason
               * lives in the server log beside the read.
               */
              const linesFold =
                lines.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-sm">
                    {lines.map((line) => {
                      // The live flag, with the line's own snapshot as the
                      // fallback — the same coalesce the RPC makes, so the box
                      // this row draws and the rule that judges it agree. Saving
                      // the row also writes that value onto the line, so the
                      // snapshot the bridge later reads agrees with it too.
                      const weighed =
                        line.products?.is_weighed ?? line.is_weighed;
                      // The per-caja price. `qty` is CAJAS and
                      // `unit_price_cents` is the ERP's per-base-unit price, so
                      // those two do not multiply out to the total beside them —
                      // `units_per_case x unit_price_cents` does, both
                      // snapshotted on the line, so `qty x this =
                      // line_total_cents` exactly and the row reads the way a
                      // staff member checking an albarán needs it to.
                      const perCase = formatEuros(
                        line.units_per_case * line.unit_price_cents,
                        locale,
                      );
                      const name = localizedName(line.name, locale);
                      return (
                        <li
                          key={line.id}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
                        >
                          <span className="font-mono text-xs text-muted">
                            {line.codart}
                          </span>
                          {/* The name is the order's own snapshot, not the
                              product's — a renamed article still reads the way
                              the customer ordered it. */}
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          {/* Why this line's box takes decimals, said once, in
                              the vocabulary the catalogue already uses. */}
                          {weighed && (
                            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                              {tCatalog("weighed")}
                            </span>
                          )}
                          {editable ? (
                            <>
                              <LineQtyForm
                                orderId={order.id}
                                itemId={line.id}
                                qty={line.qty}
                                isWeighed={weighed}
                                locale={locale}
                                tab={tab}
                                labels={{
                                  save: t("saveQty"),
                                  saveFor: t("saveQtyFor", { name }),
                                  qtyFor: t("lineQtyFor", { name }),
                                  kg: t("kg"),
                                }}
                              />
                              {/* The packaging fact the read-only row states,
                                  kept on the editable one: `CAJA×24` is what
                                  makes the price beside it legible, and 待确认
                                  is the tab where somebody is deciding a
                                  quantity against it. */}
                              <span className="text-xs text-muted tabular-nums">
                                {unitLabel(line.unit, line.units_per_case)} ×{" "}
                                {perCase}
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-muted tabular-nums">
                              {line.qty}{" "}
                              {unitLabel(line.unit, line.units_per_case)} ×{" "}
                              {perCase}
                            </span>
                          )}
                          <span className="w-20 text-right tabular-nums">
                            {formatEuros(line.line_total_cents, locale)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null;
              /**
               * Everything that used to render UNDER the card row, now the
               * content of the fold `<tr>`: the lines, the customer's note,
               * the failure box and the action forms. `null` when the order
               * has none of them — which is also the no-toggle case, so a row
               * with nothing to open never grows a dead button. The action
               * forms moving in here is deliberate: on 待确认 the staff member
               * opens the fold to CHECK THE LINES before confirming anyway,
               * and the one row the table shows stays one row tall.
               */
              const fold =
                linesFold !== null ||
                order.customer_note ||
                order.status === "bridge_failed" ||
                cancellable ? (
                  <div>
                    {linesFold}
                    {order.customer_note && (
                    <p className="mt-2 text-[12.5px]">
                      {t("customerNote")}: {order.customer_note}
                    </p>
                  )}

                  {order.status === "bridge_failed" && (
                    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                      {bridgeFailure ? (
                        <>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="font-medium">
                              {t("bridgeFailure.attempts", {
                                n: bridgeFailure.attemptCount,
                              })}
                            </span>
                            {bridgeFailure.lastErrorCode && (
                              <code className="rounded bg-red-100 px-1.5 py-0.5 text-xs">
                                {bridgeFailure.lastErrorCode}
                              </code>
                            )}
                            {bridgeFailure.failedAt && (
                              <span className="text-xs text-red-700">
                                {t("bridgeFailure.failedAt", {
                                  time:
                                    formatMadridTime(
                                      bridgeFailure.failedAt,
                                      locale,
                                    ) || "—",
                                })}
                              </span>
                            )}
                          </div>
                          {bridgeFailure.lastErrorMessage && (
                            <p className="mt-1 break-words font-mono text-xs">
                              {bridgeFailure.lastErrorMessage}
                            </p>
                          )}
                        </>
                      ) : (
                        <p>{t("bridgeFailure.detailsUnavailable")}</p>
                      )}
                    </div>
                  )}

                  {cancellable && (
                    <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-2">
                      {confirmable && (
                        <form
                          action={confirmOrder}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <input
                            type="hidden"
                            name="order_id"
                            value={order.id}
                          />
                          <input type="hidden" name="locale" value={locale} />
                          {/* So the redirect comes back to the tab in front of
                              the staff member, not to the default one. */}
                          <input type="hidden" name="estado" value={tab} />
                          <input
                            name="note"
                            // staff_confirm_order rejects anything longer.
                            maxLength={2000}
                            placeholder={t("staffNote")}
                            // One "Nota interna" per row would tell a screen
                            // reader nothing about which order it belongs to.
                            aria-label={t("staffNoteFor", {
                              n: order.order_number,
                            })}
                            className={`w-48 ${FIELD_SM}`}
                          />
                          {/* The one accent on the row, and the press this
                              queue exists for: it keeps the solid brand fill it
                              shipped with. */}
                          <button
                            type="submit"
                            aria-label={t("confirmFor", {
                              n: order.order_number,
                            })}
                            className={`${ACTION} bg-brand font-semibold text-white hover:bg-brand/90`}
                          >
                            {t("confirm")}
                          </button>
                        </form>
                      )}

                      <form
                        action={cancelOrder}
                        className="flex flex-wrap items-center gap-1"
                      >
                        <input type="hidden" name="order_id" value={order.id} />
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="estado" value={tab} />
                        <input
                          name="note"
                          maxLength={2000}
                          placeholder={t("cancelReason")}
                          aria-label={t("cancelReasonFor", {
                            n: order.order_number,
                          })}
                          className={`w-48 ${FIELD_SM}`}
                        />
                        {/* Cancelling is destructive, not the accent: it keeps the
                            semantic red it has always had. */}
                        <button
                          type="submit"
                          aria-label={t("cancelFor", { n: order.order_number })}
                          className={`${ACTION} border border-red-300 text-red-700 hover:bg-red-50`}
                        >
                          {t("cancel")}
                        </button>
                      </form>
                    </div>
                  )}

                  {order.status === "bridge_failed" && (
                    // Amber, directly under the red box it answers: the box says
                    // what the ERP refused, this offers the one move that follows
                    // fixing it.
                    <form action={requeueOrder} className="mt-3">
                      <input type="hidden" name="order_id" value={order.id} />
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="estado" value={tab} />
                      <button
                        type="submit"
                        aria-label={t("requeueFor", { n: order.order_number })}
                        className={`${ACTION} border border-amber-400 bg-amber-50 font-medium text-amber-900 hover:bg-amber-100`}
                      >
                        {t("requeue")}
                      </button>
                    </form>
                  )}
                  </div>
                ) : null;

              return (
                <QueueRow
                  key={order.id}
                  number={
                    <span className="font-num text-[12.5px] font-semibold">
                      {order.order_number}
                    </span>
                  }
                  date={formatOrderDate(order.created_at, locale)}
                  client={
                    <>
                      <p className="truncate text-[13.5px] font-semibold">
                        {order.companies?.name ?? "—"}
                      </p>
                      {meta.length > 0 && (
                        <p className="mt-0.5 truncate text-[11.5px] text-muted">
                          {meta.join(" · ")}
                        </p>
                      )}
                    </>
                  }
                  toggleLabel={t("lines")}
                  toggleAria={t("orderLinesFor", { n: order.order_number })}
                  printHref={`/${locale}/staff/pedidos/${order.id}/imprimir`}
                  printLabel={t("print.link")}
                  printAria={t("print.linkFor", { n: order.order_number })}
                  badge={<OrderStatusBadge status={order.status} />}
                  price={
                    <>
                      <span className="sr-only">{tCart("subtotal")}: </span>
                      {formatEuros(order.subtotal_cents, locale)}
                    </>
                  }
                  fold={fold}
                />
              );
            })}
              </tbody>

              {/* The truth this page has never told. It reads the newest
                  `PAGE_SIZE` = 50 orders of the selected view, so a tab holding
                  214 of them has always looked, from here, like a tab holding
                  50. The chip's count is the size of the view; this says how
                  much of it is on screen, and only when that count actually
                  arrived. Under a SEARCH the chip count no longer describes
                  what is on screen at all, so the footer switches to the one
                  honest figure it has — how many rows the search returned,
                  which the 50-cap can still truncate and the cap sentence
                  still covers. A numbered pager stays a recorded follow-up. */}
              {(q || activeCount !== null) && (
                <tfoot>
                  <tr className="border-t border-[#F4F0EC]">
                    <td
                      colSpan={7}
                      className="px-[18px] py-3.5 text-xs text-muted"
                    >
                      {q ? (
                        <>
                          <span>{t("searchCount", { n: orders.length })}</span>
                          {orders.length >= PAGE_SIZE && (
                            <>
                              {" · "}
                              <span>{t("queueShowing", { m: PAGE_SIZE })}</span>
                            </>
                          )}
                        </>
                      ) : activeCount !== null ? (
                        <>
                          <span>{t("queueTotal", { n: activeCount })}</span>
                          {activeCount > PAGE_SIZE && (
                            <>
                              {" · "}
                              <span>{t("queueShowing", { m: PAGE_SIZE })}</span>
                            </>
                          )}
                        </>
                      ) : null}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </StaffShell>
  );
}
