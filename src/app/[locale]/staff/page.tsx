import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { OrderStatusBadge } from "@/components/order-status-badge";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD, ADMIN_TD } from "@/components/ui";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import {
  bridgeCountLabelKey,
  bridgeStateKey,
  deriveBridgeStatuses,
  formatMadridTime,
  relativeAge,
  type BridgeJob,
  type BridgeTone,
} from "@/lib/bridge-status";
import { localizedName } from "@/lib/catalog/display";
import {
  formatOrderDate,
  funnelWidth,
  madridDayStartIso,
  type OrderStatus,
} from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { readLoggedCount } from "@/lib/shell-counts";
import type { Database } from "@/lib/supabase/database.types";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";

export const dynamic = "force-dynamic";

/**
 * What a figure that did not arrive looks like, everywhere on this page. At
 * module scope because it is a constant of the page and not of one render: it
 * closes over nothing, and every other literal this file reuses already lives up
 * here beside it.
 */
const DASH = "—";

/**
 * Four states, four colours, and `busy` deliberately not among the alarming
 * ones: the orders job is scheduled every minute and its lock stops the odd
 * overlapping run, which is the machine working, not failing. Violet is the same
 * hue `processing` wears on the order badge — "something is in flight".
 */
const TONE_CLASS: Record<BridgeTone, string> = {
  good: "bg-green-100 text-green-800",
  busy: "bg-violet-100 text-violet-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-red-100 text-red-800",
};

/**
 * How much of each list this page draws. Six recent orders is the mockup's own
 * count (`docs/design/dada-staff-admin.dc.html:140`) and six paused products is
 * its alert card's (:161); the failure list is FIVE because every one of its
 * rows is a job somebody has to do by hand, and a to-do card that scrolls is a
 * to-do card nobody finishes. The truncation is no longer silent: the card's own
 * footer prints 共 {n} 单 · 显示最早 5 单 whenever the total runs past this, and the
 * sidebar's 待办 figure and the funnel's bridge_failed row carry it too.
 */
const RECENT_LIMIT = 6;
const PAUSED_LIMIT = 6;
const FAILED_LIMIT = 5;

/**
 * The funnel's colour ramp, in pipeline order —
 * `docs/design/dada-staff-admin.dc.html:579-584`: `#E0231C`, `#F0806A`,
 * `#C4B7AC`, `#1C1917`, red draining to ink as an order moves down the machine.
 *
 * Three of its five stops are values the palette ALREADY carries, so they are
 * named rather than retyped: `#E0231C` is `--color-brand`, `#1C1917` is
 * `--color-ink` and the alarm bar's `#B31710` is `--color-brand-ink`
 * (`globals.css:56`, `:76` and `:81` — the three are not contiguous). Only the
 * two middle shades have no token — a washed coral and a warm stone that exist
 * nowhere else in the portal — and those stay literal under the standard "not a
 * token because" rule: they are one admin chart's ramp, not palette entries a
 * customer screen may reach for.
 *
 * The bars are DECORATION beside the figures — every row prints its own count in
 * `font-num` to the right of the track — so no contrast ratio is claimed for
 * them; the numbers carry the data.
 */
const FUNNEL_STAGES: readonly { status: OrderStatus; bar: string }[] = [
  { status: "submitted", bar: "bg-brand" },
  { status: "confirmed", bar: "bg-[#F0806A]" },
  { status: "processing", bar: "bg-[#C4B7AC]" },
  { status: "injected", bar: "bg-ink" },
];

/**
 * The alarm row, drawn under a rule and apart from the four above it:
 * `bridge_failed` is not a stage an order passes THROUGH, it is where one stops.
 */
const FUNNEL_FAILED: { status: OrderStatus; bar: string } = {
  status: "bridge_failed",
  bar: "bg-brand-ink",
};

/**
 * The mini table's header cell, at the house's admin-table metrics.
 *
 * Stays local: `h-10` here against `/staff/productos`'s `h-[42px]`, so the two
 * header strings are NOT the same string and there is nothing to share. The
 * body cell is — it is `ADMIN_TD` in `components/ui.ts`, byte-identical on both
 * pages.
 */
const TH = "h-10 px-3 text-left align-middle font-medium";

/**
 * The KPI strip's internal hairlines, per cell, at both of its layouts.
 *
 * `divide-x` alone will not do it. Tailwind puts the rule on every child but the
 * LAST, so in the mockup's four-across it is right — three rules between four
 * cells — but in the two-across this page falls back to below `lg` it borders
 * cells 0, 1 and 2, and cell 1 sits at the card's own right edge: a stray
 * hairline doubling the card border. Naming each cell's rules instead draws the
 * 2×2 cross the mobile layout actually wants (a vertical rule between the
 * columns, a horizontal one between the rows) and the mockup's three verticals
 * at `lg`.
 */
const KPI_RULES = [
  "",
  "border-l lg:border-l",
  "border-t lg:border-t-0 lg:border-l",
  "border-l border-t lg:border-t-0",
];

/** The recent-orders row: the customer-readable columns plus the restaurant. */
type RecentOrder = PublicOrder & {
  companies: { name: string; codcli: number | null } | null;
};

/** A paused article, as the alert card draws it. */
type PausedProduct = Pick<
  Database["public"]["Tables"]["products"]["Row"],
  "id" | "codart" | "name"
>;

export default async function StaffHome({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff`);
  const { supabase, pendingStaff } = await beginStaff(locale);
  const t = await getTranslations("staff");
  // The status vocabulary is the customer's, reused rather than duplicated into
  // the staff namespace — the funnel's row labels and the 进行中 breakdown are
  // the same seven words the badge prints.
  const tOrders = await getTranslations("orders");

  /**
   * One `head: true` count on one status. No row comes back, only the
   * `Content-Range` header — the idiom the shell and the queue both read their
   * figures with. The select list names one real column: `orders` is
   * column-revoked (`staff_note`) and a `*` there 403s the whole query.
   *
   * These predicates now have THREE readers. `StaffShell` counts `submitted`,
   * `bridge_failed` and `products.is_available = false` for the sidebar's 待办
   * block and its 订单 badge (`staff-shell.tsx:132-149`); `/staff/pedidos`
   * counts `submitted`, `confirmed` and `bridge_failed` again for its tab chips
   * (`pedidos/page.tsx:218-223`); and this page counts six of them for the KPI
   * strip and the funnel. Same request, separate rounds — the shell renders
   * after this page's reads have resolved — so the sidebar figure and the KPI
   * beside it can differ by the milliseconds between them. Both are real;
   * neither is stale by design. Unifying them behind one `cache()`d read stays
   * the recorded follow-up it was in A4, deliberately not done here.
   */
  const orderCount = (status: OrderStatus) =>
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("status", status);

  // Every read on this page is a SESSION read, and the case for firing them all
  // BESIDE the guard rather than behind it rests on what the policies actually
  // say — neither of these two is staff-only. `products_read` is
  // `is_staff() OR my_company_id() is not null`
  // (`supabase/migrations/20260815101406_security_order_integrity.sql:166-171`):
  // ANY logged-in customer reads the whole product table, which is how the
  // catalog works at all. `orders_read` is
  // `is_staff() OR company_id = my_company_id()` (:189-194). So the worst case
  // for a caller who turns out NOT to be staff is their own restaurant's orders
  // plus catalog facts /catalogo already hands them, and `finishStaff` redirects
  // out of this `Promise.all` before a row of either is rendered. The same
  // argument the queue and the categories page already make.
  //
  // The guardrail that argument carries with it: it is an argument about THESE
  // predicates. A read on a table whose policy is genuinely staff-only has no
  // "they could already see this" to stand on, so it belongs BEHIND the guard
  // and not in this `Promise.all`.
  //
  // `bridge_status` is the one read here that IS staff-only —
  // `bridge_status_staff_read` is `is_staff()` alone
  // (`20260816041200_bridge_status.sql:34-36`) — and it sits beside the guard on
  // a narrower argument of its own: it holds no customer data whatsoever (job
  // names, run times and tallies about our own machine), and RLS answers a
  // non-staff caller with an empty set rather than an error. It also stays on
  // the ordinary session client rather than the admin one for the reason it
  // always has: the admin client throws when `SUPABASE_SERVICE_ROLE_KEY` is
  // absent, and a status card must never be the reason the whole staff home
  // 500s and takes the dashboard with it.
  //
  // The seven counts ride under ONE step because they go out together; each list
  // keeps its own step so a slow one is visible in the `[perf]` line by name.
  //
  // TWELVE requests, and two of them are foldable: `pausedCount` and
  // `bridgeFailedCount` count the same sets their lists below already select, so
  // `{ count: "exact" }` on those two SELECTs would return the true total beside
  // the limited rows and take this to ten. They are kept separate on purpose. A
  // folded count shares its list's fate — one failure would take BOTH down, and
  // the alert cards would then show an empty list beside a dashed figure with
  // nothing left on the card that knows better. The count is those cards' honest
  // signal precisely because it can survive its list.
  const [
    staffUser,
    { data: heartbeats, error },
    countResults,
    recentResult,
    pausedResult,
    failedResult,
    oldestResult,
  ] = await Promise.all([
    finishStaff(pendingStaff, locale),
    perf.step(
      "bridge",
      supabase.from("bridge_status").select("job, last_run_at, ok, detail"),
    ),
    perf.step(
      "counts",
      Promise.all([
        // TODAY, on Madrid's calendar and not on UTC's — see
        // `madridDayStartIso`, whose whole difficulty is the two days a year
        // when the two answers differ by an hour. This is the helper's only
        // call site; the offset arithmetic is what needed the unit test, not
        // the query.
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .gte("created_at", madridDayStartIso(new Date())),
        orderCount("submitted"),
        orderCount("confirmed"),
        orderCount("processing"),
        orderCount("injected"),
        orderCount("bridge_failed"),
        supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .eq("is_available", false),
      ]),
    ),
    perf.step(
      "recent",
      supabase
        .from("orders")
        .select(`${PUBLIC_ORDER_COLUMNS}, companies:company_id(name, codcli)`)
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
    ),
    // `is_available`, `codart` and `name` are all authenticated-granted columns
    // (only the six `price_N_cents` are revoked), so this is a session read like
    // the rest — the same table the shell already COUNTS on the session client.
    //
    // Ordered by CODART and not by "recently paused", because that second thing
    // is not recoverable from this table. `price-sync` runs nightly and PATCHes
    // every article it read out of `articulo`
    // (`bridge/jobs/price-sync.ts:219-221`; matched=2854 in the runbook's own
    // sample run), and `products_updated_at` fires `set_updated_at()` on every
    // UPDATE with no "only if something changed" guard
    // (`0002_catalog.sql:30-31`, `0001_core.sql:2-3`) — so by breakfast
    // `updated_at` says the same thing about the whole catalog. Codart at least
    // gives the six rows a stable scan order, and it is the string staff match
    // against Wingest, which is what the second line of each row prints.
    perf.step(
      "paused",
      supabase
        .from("products")
        .select("id, codart, name")
        .eq("is_available", false)
        .order("codart")
        .limit(PAUSED_LIMIT),
    ),
    // OLDEST first, both here and below: a to-do list is worked from the end
    // that has been waiting longest.
    perf.step(
      "failed",
      supabase
        .from("orders")
        .select(PUBLIC_ORDER_COLUMNS)
        .eq("status", "bridge_failed")
        .order("created_at", { ascending: true })
        .limit(FAILED_LIMIT),
    ),
    perf.step(
      "oldestSubmitted",
      supabase
        .from("orders")
        .select("created_at")
        .eq("status", "submitted")
        .order("created_at", { ascending: true })
        .limit(1),
    ),
  ]);
  perf.end();

  // A failed bridge read renders the same "nothing has ever reported" state as
  // an empty table. It is the honest thing to show — we know nothing either way
  // — and the reason lands in the server log rather than on a staff screen.
  if (error) console.error("staff bridge_status query:", error);

  // A list that came back empty because the query FAILED is indistinguishable,
  // on screen, from a list that is genuinely empty — 无停售商品 and 暂无待办 are what
  // both look like. On the two alert cards a second figure answers that: the
  // paused card's header count and the todos card's footer total are separate
  // reads (see the fan-out note above), they dash on failure rather than reading
  // 0, and a live count beside an empty list is a visible contradiction — which
  // is the point. It is the honest shape, not a tidy one.
  //
  // The RECENT card is the exception and has no such figure: 此视图中没有订单 can
  // equally mean "the read failed", and nothing beside it says otherwise. Only
  // the log below does.
  if (recentResult.error)
    console.error("staff home recent orders query:", recentResult.error);
  if (pausedResult.error)
    console.error("staff home paused products query:", pausedResult.error);
  if (failedResult.error)
    console.error("staff home bridge failures query:", failedResult.error);
  if (oldestResult.error)
    console.error("staff home oldest submitted query:", oldestResult.error);

  const recent: RecentOrder[] = recentResult.data ?? [];
  const paused: PausedProduct[] = pausedResult.data ?? [];
  const failed: PublicOrder[] = failedResult.data ?? [];
  const oldestSubmittedAt: string | null =
    oldestResult.data?.[0]?.created_at ?? null;

  const [
    todayResult,
    submittedResult,
    confirmedResult,
    processingResult,
    injectedResult,
    bridgeFailedResult,
    pausedCountResult,
  ] = countResults;
  // All seven read and logged by the shared half (`lib/shell-counts.ts`), which
  // prints `staff home <name> count (status <n>)` and names BOTH failure shapes
  // — including the quiet one, a `head: true` request whose response carries no
  // error JSON to parse. `null` reaches the screen as an em dash, never as 0: a
  // count that did not arrive must not be able to tell a staff member there is
  // nothing to do.
  const todayCount = readLoggedCount("staff home", "today", todayResult);
  const submittedCount = readLoggedCount(
    "staff home",
    "submitted",
    submittedResult,
  );
  const confirmedCount = readLoggedCount(
    "staff home",
    "confirmed",
    confirmedResult,
  );
  const processingCount = readLoggedCount(
    "staff home",
    "processing",
    processingResult,
  );
  const injectedCount = readLoggedCount(
    "staff home",
    "injected",
    injectedResult,
  );
  const bridgeFailedCount = readLoggedCount(
    "staff home",
    "bridge failed",
    bridgeFailedResult,
  );
  const pausedCount = readLoggedCount("staff home", "paused", pausedCountResult);

  // ── everything below this line is derivation and markup ───────────────────

  /**
   * 进行中: the three states between confirmation and the delivery note. It is
   * `null` when ANY of the three is — a sum with a hole in it is not a sum, and
   * "12 in flight" computed from two counts and a failure would be a smaller
   * number stated with the same confidence as a whole one.
   */
  const activeCount =
    confirmedCount === null || processingCount === null || injectedCount === null
      ? null
      : confirmedCount + processingCount + injectedCount;

  /**
   * The five bars, each carrying its own count. Keyed by status rather than
   * zipped by position so the ramp above and the figures here cannot drift apart
   * — a row whose colour and number came from two different lists is the one bug
   * this card could have that nobody would see. `Partial<Record<OrderStatus,…>>`
   * and not `Record<string,…>` is what makes that a real guarantee rather than a
   * hope: a mistyped key here is a compile error, where under `string` it was a
   * row that dashed forever and looked exactly like a count that never arrived.
   * `Partial` because the map holds five of the seven statuses on purpose —
   * `albaran` and `cancelled` are not stages this funnel draws.
   */
  const funnelCounts: Partial<Record<OrderStatus, number | null>> = {
    submitted: submittedCount,
    confirmed: confirmedCount,
    processing: processingCount,
    injected: injectedCount,
    bridge_failed: bridgeFailedCount,
  };
  const funnel = [...FUNNEL_STAGES, FUNNEL_FAILED].map((stage) => ({
    ...stage,
    count: funnelCounts[stage.status] ?? null,
  }));
  /**
   * The longest bar. `Math.max(0, …)` rather than `Math.max(…)` so an all-null
   * funnel is 0 and not `-Infinity`; `funnelWidth` turns a zero max into an
   * empty track for every row (its own table pins that). The `?? 0` reads as it
   * should: a count that never arrived cannot be the longest bar, and its own
   * row draws an empty track and a dash.
   */
  const funnelMax = Math.max(0, ...funnel.map((row) => row.count ?? 0));
  /**
   * 共 {n} 单 in the funnel header, or NO header figure at all when one of the
   * five counts is missing. There is no em-dash option here: `queueTotal` is an
   * ICU plural in Spanish («{n, plural, …}»), so it needs a number, and a total
   * computed over a hole would be a smaller figure stated as a whole one — the
   * same call `activeCount` makes above. The rows' own dashes carry the news.
   * The `?? 0` in the reduce is unreachable — the `some` above already returned
   * on any null — and stays only because the array's element type says nothing
   * about which branch we are in.
   */
  const funnelTotal = funnel.some((row) => row.count === null)
    ? null
    : funnel.reduce((sum, row) => sum + (row.count ?? 0), 0);

  const relative = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "es-ES", {
    numeric: "auto",
  });
  /**
   * TWO formatters, differing in one option, because the two places that print
   * an age want different words at the same value. `numeric: "auto"` swaps a
   * calendar word in at one and two days — 昨天 / 前天, «ayer» / «anteayer» — and
   * the to-do card is an AGE column on a list drawn oldest-first, so multi-day
   * rows are precisely what lands in it and «anteayer» in a column of «hace 3
   * días» is a different unit of measure, not a nicety. `always` keeps it a
   * duration: 3天前 / «hace 3 días», and 1天前 / «hace 1 día».
   *
   * The heartbeat below keeps `relative` exactly as it shipped, byte for byte —
   * this round does not reopen that region. Its ages CAN cross a day too (a
   * stopped job keeps aging, and `price-sync` is still fresh at 25 hours: its
   * window is 26), so 昨天 is reachable there as well; it is left alone because
   * three rows about freshness, each carrying its own badge and its exact
   * instant on hover, are not the reading problem a COLUMN of ages on a backlog
   * worked oldest-first is.
   */
  const relativeAlways = new Intl.RelativeTimeFormat(
    locale === "zh" ? "zh-CN" : "es-ES",
    { numeric: "always" },
  );

  /**
   * How long something has been waiting, as a DURATION («42 minutos», 42分钟)
   * rather than as a point in the past.
   *
   * `Intl.RelativeTimeFormat` — which every other age on this page uses — would
   * give «hace 42 minutos» / 42分钟前, and 已等待 {time} / «lleva {time}» around
   * that reads "has been waiting 42 minutes ago". Same split of the interval
   * (`relativeAge`, the heartbeat's own), formatted as a quantity of units.
   */
  const waited = (ms: number): string => {
    const { value, unit } = relativeAge(ms);
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "es-ES", {
      style: "unit",
      unit,
      unitDisplay: "long",
    }).format(value);
  };

  // `new Date().getTime()` rather than `Date.now()`: the purity lint rejects the
  // latter by name, and every other clock read in this file — the heartbeat's,
  // the day filter's — is already a `new Date()`.
  const now = new Date().getTime();
  /**
   * REAL items only: every bridge failure sitting in the queue, oldest first,
   * and one row for how long the oldest unconfirmed order has been waiting. The
   * mockup's 催报价 / 修改了收货时段 / 待审核客户 (`:601-605`) are three CRM
   * events this portal does not record (decision 1), and inventing them here
   * would put a to-do list in front of staff that nothing can ever clear.
   */
  const todos: {
    key: string;
    text: string;
    href: string | null;
    age: string | null;
    at: string | null;
  }[] = failed.map((order) => {
    const { value, unit } = relativeAge(
      now - new Date(order.created_at).getTime(),
    );
    return {
      key: order.id,
      text: t("todoBridgeFailed", { n: order.order_number }),
      href: `/${locale}/staff/pedidos?estado=bridge_failed`,
      // The order's OWN age, not the failure's: `failed_at` lives behind
      // `staff_get_order_bridge_failures` (the sensitive columns are revoked
      // from authenticated), and this card is not worth a fourth round trip to
      // move a relative time by a few minutes. The `title` says which instant
      // it is, the way the heartbeat's does.
      age: relativeAlways.format(-value, unit),
      at: formatMadridTime(order.created_at, locale),
    };
  });
  if (oldestSubmittedAt) {
    todos.push({
      key: "oldest-submitted",
      text: t("todoOldestSubmitted", {
        time: waited(now - new Date(oldestSubmittedAt).getTime()),
      }),
      // No link: the row is not one order, it is the age of the whole 待确认
      // backlog — the sidebar entry and the KPI beside it both open that view.
      href: null,
      // …and no second time on the right either: the sentence IS the age. `at`
      // is still set, and still reaches the screen — the row carries the exact
      // instant as its `title`, which is why that hangs off `at` and not off the
      // age chip this row does not have.
      age: null,
      at: formatMadridTime(oldestSubmittedAt, locale),
    });
  }

  const statuses = deriveBridgeStatuses(heartbeats ?? [], new Date());
  // "Nothing has EVER written here" is a different message from "one job is
  // quiet": it means the bundle is not on the server, or no scheduled task was
  // ever created. Rows for jobs this build does not know do not count as
  // deployment — `deriveBridgeStatuses` ignores them, so this reads the derived
  // views rather than the raw result set.
  const deployed = statuses.some((status) => status.freshness !== "missing");

  /**
   * The label for one count, looked up under ITS OWN job: `injected` means
   * "written into Wingest" for `orders` and "waiting for an albarán" for
   * `albaran-sync`. A key with no label falls back to the raw key.
   */
  const countLabel = (job: BridgeJob, key: string): string => {
    const labelKey = bridgeCountLabelKey(job, key);
    return labelKey ? t(`bridge.counts.${labelKey}`) : key;
  };

  /**
   * The four KPI cells. Only the FIRST is day-scoped, which is why the page is
   * headed 概览 and not the mockup's 今日概览 (`:88`) — three of these four
   * figures are backlog, exactly as the sidebar's 待办 block is, and a 今日 over
   * them would be a lie about three quarters of the strip.
   *
   * No deltas and no sub-lines but one. The mockup gives every cell a `+3` and a
   * sentence (`:573-578`); both need history this portal does not keep — there
   * is no yesterday's count stored anywhere — and 截单前还有 5 小时 20 分 needs a
   * cut-off time that is not a feature (decision 3). The ONE honest sub is
   * 进行中's, which spells out the three states its own figure adds up.
   */
  const kpis: { key: string; label: string; value: number | null; sub: string | null }[] =
    [
      { key: "today", label: t("kpiToday"), value: todayCount, sub: null },
      {
        key: "submitted",
        label: t("tabSubmitted"),
        value: submittedCount,
        sub: null,
      },
      {
        key: "active",
        label: t("kpiActive"),
        value: activeCount,
        sub: [
          `${tOrders("status.confirmed")} ${confirmedCount ?? DASH}`,
          `${tOrders("status.processing")} ${processingCount ?? DASH}`,
          `${tOrders("status.injected")} ${injectedCount ?? DASH}`,
        ].join(" · "),
      },
      {
        key: "paused",
        label: t("shell.backlogUnavailable"),
        value: pausedCount,
        sub: null,
      },
    ];

  return (
    <StaffShell
      locale={locale}
      // 概览 / Resumen. No breadcrumb: the trail of the home page would be its
      // own root crumb and nothing else, which is why `StaffShell` makes the
      // prop optional.
      title={t("homeTitle")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      {/* The mockup's date line (`:89`), minus the half of it that is fiction:
          its 截单时间 15:00 前 is a cut-off feature nobody has built (decision
          3), so what is left is the real thing this page can say — today, on
          MADRID's calendar, because the clock the counts are filtered on is the
          Spanish one and the ERP server it talks to runs on China time. Its 今日
          dropdown and 批量报价 5 单 button beside it are out for the same reason
          (decisions 1 and 3). */}
      <p className="mt-2 text-[13px] text-muted">
        {new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "es-ES", {
          timeZone: "Europe/Madrid",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }).format(new Date())}
      </p>

      {/* ONE card holding four cells with internal rules, per the mockup's own
          `repeat(4,1fr)` strip (`:97-108`); `overflow-hidden` is what keeps
          those rules inside the 12px radius. Two across below `lg`, where 4×34px
          figures would be four columns of 60px. */}
      <div
        className={`${ADMIN_CARD} mt-[18px] grid grid-cols-2 overflow-hidden lg:grid-cols-4`}
      >
        {kpis.map((kpi, index) => (
          <div
            key={kpi.key}
            className={`flex flex-col gap-2.5 border-[#EDE9E5] p-5 ${
              // `?? ""` and not a bare index: a fifth KPI would index past the
              // array and render `class="undefined"` on the cell.
              KPI_RULES[index] ?? ""
            }`}
          >
            {/* The mockup's `#79726B` label. It maps to `text-ink-soft`
                (#57504A, 7.92:1 on this card's white) rather than to
                `text-muted` (#6E6760, 5.57:1). The mockup's own shade fails
                nothing — 4.74:1 clears AA for text this size — but it is LIGHTER
                than both candidates, not between them, so neither token is a
                faithful match and the choice is which way to miss. Darker, for a
                label that names a figure somebody is scanning for. */}
            <p className="text-[12.5px] text-ink-soft">{kpi.label}</p>
            <p className="font-num text-[34px] font-bold leading-none tabular-nums">
              {kpi.value === null ? (
                // An em dash at 34px is a 20-pixel black bar — it reads as a
                // redaction, not as "we do not know". Two thirds of the size and
                // muted says the same thing quietly; `leading-none` on the
                // parent keeps the line box 34px either way, so a dashed cell is
                // exactly as tall as its neighbours.
                <span className="text-[24px] text-muted">{DASH}</span>
              ) : (
                kpi.value
              )}
            </p>
            {kpi.sub && (
              <p className="text-[11.5px] text-muted">{kpi.sub}</p>
            )}
          </div>
        ))}
      </div>

      {/* The mockup's `1fr 380px` (`:110`). Below `lg` the two columns stack in
          source order — funnel, recent orders, then the two alert cards — and
          nothing on this page has a fixed width, so a 390px drawer scrolls
          vertically and never sideways. */}
      <div className="mt-[18px] grid gap-[18px] lg:grid-cols-[1fr_380px] lg:items-start">
        {/* `min-w-0` on both columns, and it is load-bearing: a grid item's
            default `min-width: auto` is its CONTENT's width, so the recent
            table's `min-w-[560px]` would push this column — and with it the
            whole page — past 390px on a phone-width drawer, which is exactly the
            sideways scroll the table's own `overflow-x-auto` exists to
            prevent. Same fix `staff-shell.tsx:193` makes for the main column. */}
        <div className="flex min-w-0 flex-col gap-[18px]">
          <section className={ADMIN_CARD}>
            <div className="flex items-baseline justify-between gap-3 border-b border-[#EDE9E5] px-5 py-4">
              <h2 className="text-[15px] font-bold">{t("funnelTitle")}</h2>
              {/* NOW, not the mockup's 本周 (`:116`): every bar is a count of
                  orders SITTING in that state at this instant, so a time word
                  over it would describe a different query. `queueTotal` is the
                  queue's own 共 {n} 单, reused.

                  This is the ONE figure on the page whose absence is silent —
                  every other missing number leaves an em dash where it stood,
                  and this leaves nothing at all. Deliberate, not an oversight:
                  the es `queueTotal` is an ICU plural, which has no slot a dash
                  can go in. The five rows below each dash for themselves, so the
                  news is on the card either way. */}
              {funnelTotal !== null && (
                <p className="text-xs text-muted">
                  {t("queueTotal", { n: funnelTotal })}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-3.5 px-5 py-[18px]">
              {funnel.map((row) => (
                <div
                  key={row.status}
                  className={`flex items-center gap-3.5 ${
                    // The alarm row sits apart, under the rule: the four above
                    // it are stages an order passes through, this is where one
                    // stops.
                    row.status === "bridge_failed"
                      ? "border-t border-[#F4F0EC] pt-3.5"
                      : ""
                  }`}
                >
                  {/* 104px, not the mockup's 76 (`:121`): its labels are 3-4
                      character inventions (待报价, 待发货) and ours are the
                      SHIPPED status words — 需要人工处理 is six CJK characters =
                      78px at 13px, and «Revisión manual» is wider still. The
                      column is sized so neither wraps. */}
                  <span
                    className={`w-[104px] shrink-0 text-[13px] ${
                      row.status === "bridge_failed"
                        ? "font-semibold text-brand-ink"
                        : "text-ink-soft"
                    }`}
                  >
                    {tOrders(`status.${row.status}`)}
                  </span>
                  <span className="h-[26px] flex-1 overflow-hidden rounded-md bg-[#F4F0EC]">
                    <span
                      className={`block h-full rounded-md ${row.bar}`}
                      style={{ width: funnelWidth(row.count, funnelMax) }}
                    />
                  </span>
                  <span
                    className={`w-[46px] shrink-0 text-right font-num text-base font-semibold tabular-nums ${
                      // Label and figure take the same ink on the failure row,
                      // so the whole line reads as one alarm rather than as a
                      // red word beside a black number.
                      row.status === "bridge_failed" ? "text-brand-ink" : ""
                    }`}
                  >
                    {row.count ?? DASH}
                  </span>
                  {/* …and nothing after it. The mockup's fifth column is a 64px
                      hint (`:126` — 平均 26 分, 签收率 100%), dropped for the same
                      reason the KPI deltas are: every one of those sentences is
                      computed against history this portal does not keep. */}
                </div>
              ))}
            </div>
          </section>

          <section className={`${ADMIN_CARD} overflow-hidden`}>
            <div className="flex items-baseline justify-between gap-3 border-b border-[#EDE9E5] px-5 py-4">
              <h2 className="text-[15px] font-bold">{t("recentTitle")}</h2>
              <Link
                href={`/${locale}/staff/pedidos?estado=all`}
                className="shrink-0 text-[12.5px] font-semibold text-brand-ink"
              >
                {t("allOrders")}
                <span aria-hidden="true"> →</span>
              </Link>
            </div>

            {recent.length === 0 ? (
              <p className="p-10 text-center text-muted">{t("noOrders")}</p>
            ) : (
              /* `overflow-x-auto` on the wrapper, so the TABLE is what scrolls
                 sideways in a 390px drawer and the page body never does — the
                 products table's own arrangement. */
              <div className="overflow-x-auto">
                {/* A real `<table>`, not the mockup's div grid (`:137-151`):
                    four columns with a header each is tabular data, and the grid
                    version hands a screen reader four unrelated boxes per row.
                    Every `<th>` takes `scope="col"`, as `/staff/productos`
                    does.

                    NO 商品 / 种 column, which the mockup puts third (header
                    `:138`, cell `:147`): the line count is not on `orders`, so
                    it would cost a second read of `order_items` for six rows —
                    the plan drops it for this card and the queue's own
                    `<details>` summary already carries it where somebody is
                    working the order. */}
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-[#EDE9E5] bg-field text-[11.5px] text-muted">
                      {/* 120px / 130px / 150px, all three sized off the SPANISH
                          header, which is the long one in every case
                          («N.º de pedido», «Fecha del pedido», «Estado» over
                          «Revisión manual»); zh's 单号 / 下单日期 / 状态 are half
                          that. At the mockup's own widths the first two headers
                          wrapped onto a second line. */}
                      <th scope="col" className={`${TH} w-[120px] pl-5`}>
                        {t("colOrder")}
                      </th>
                      {/* 客户 / «Cliente» — the sidebar's own word for the
                          restaurant that placed it (decision 7's relabel), not
                          a second noun invented for a column header. Its OWN key
                          rather than `nav.users`, though the zh is the same
                          string either way: the nav entry is a destination
                          holding many of them and reads «Clientes», while a
                          column header names the one entity on each row. */}
                      <th scope="col" className={TH}>
                        {t("colClient")}
                      </th>
                      {/* 下单日期 / Fecha del pedido: `created_at`'s shipped
                          label, the same one the queue row gives it. */}
                      <th scope="col" className={`${TH} w-[130px]`}>
                        {tOrders("placedAt")}
                      </th>
                      {/* 150px, measured rather than guessed: the widest chip
                          here is 需要人工处理 / «Revisión manual», and at the
                          badge's 12px semibold + `px-2` that is ~88px in zh and
                          ~104px in es — against the 118px this column leaves
                          once its own 12px and the card's 20px are taken. At
                          the mockup's 110 both wrapped to two lines. */}
                      <th scope="col" className={`${TH} w-[150px] pr-5 text-right`}>
                        {t("colStatus")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F4F0EC]">
                    {recent.map((order) => (
                      <tr key={order.id}>
                        {/* `font-num` for the DIGITS: Archivo carries no CJK, so
                            the numeral face is exactly what a column of order
                            numbers wants. */}
                        <td className={`${ADMIN_TD} pl-5 font-num text-[12.5px]`}>
                          {order.order_number}
                        </td>
                        <td className={`${ADMIN_TD} max-w-0`}>
                          <p className="truncate text-[13px] font-semibold">
                            {order.companies?.name ?? DASH}
                          </p>
                          {order.companies?.codcli != null && (
                            <p className="truncate font-num text-[11.5px] text-muted">
                              {order.companies.codcli}
                            </p>
                          )}
                        </td>
                        {/* Absolute, not 今天 09:12: a queue is worked against
                            dated paperwork, and this card reaches back over
                            whatever the six newest orders happen to be. */}
                        <td className={`${ADMIN_TD} text-[12.5px] text-ink-soft`}>
                          {formatOrderDate(order.created_at, locale)}
                        </td>
                        <td className={`${ADMIN_TD} pr-5 text-right`}>
                          <OrderStatusBadge status={order.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-[18px]">
          {/* The mockup's red-wash alert card — border `#FBE4E2` on `#FFF8F7`
              with an inner `#FBE9E7` row rule (`:156-171`). The three are ONE
              card's wash, the only red-wash surface anywhere on /staff, which is
              exactly why they are literals here and not palette entries: the
              token map's admin row lists `#FCFBFA` and `#EDE9E5` as the two
              admin one-offs, and this trio is the third — noted, scoped to this
              card, and reachable by no customer screen.

              Its subject is NOT the mockup's 缺货 / 库存预警: there is no
              inventory in this system (decision 2). The real signal is
              `is_available = false`, whose staff word already shipped as 停售 on
              the products toggle and as 停售商品 in the sidebar's backlog. */}
          <section className="overflow-hidden rounded-xl border border-[#FBE4E2] bg-[#FFF8F7]">
            <div className="flex items-center justify-between gap-3 border-b border-[#FBE4E2] px-[18px] py-4">
              <h2 className="text-[15px] font-bold text-brand-ink">
                {t("shell.backlogUnavailable")}
              </h2>
              {/* The KPI's own figure — the count of the whole table, not the
                  length of the six-row list under it. 13px, the mockup's size
                  (`:159`): with no size of its own it inherited the 16px body
                  and drew a figure heavier than the 15px heading beside it. */}
              <p className="font-num text-[13px] font-bold tabular-nums text-brand-ink">
                {pausedCount ?? DASH}
              </p>
            </div>
            {paused.length === 0 ? (
              <p className="px-[18px] py-6 text-[13px] text-muted">
                {t("noPaused")}
              </p>
            ) : (
              <ul>
                {paused.map((product) => (
                  <li
                    key={product.id}
                    className="border-b border-[#FBE9E7] px-[18px] py-3"
                  >
                    <p className="text-[13px] font-semibold">
                      {localizedName(product.name, locale)}
                    </p>
                    {/* The mockup's second line is a 规格 (10 斤 / 箱); ours is
                        the codart, which is the thing staff match against
                        Wingest and the freepos export. */}
                    <p className="mt-0.5 font-num text-[11.5px] text-muted">
                      {product.codart}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/${locale}/staff/productos`}
              className="block px-[18px] py-3 text-[12.5px] font-semibold text-brand-ink"
            >
              {t("goProducts")}
              <span aria-hidden="true"> →</span>
            </Link>
          </section>

          <section className={`${ADMIN_CARD} overflow-hidden`}>
            <h2 className="border-b border-[#EDE9E5] px-[18px] py-4 text-[15px] font-bold">
              {t("todosTitle")}
            </h2>
            {todos.length === 0 ? (
              // 暂无待办, not 今日无待办: both kinds of row on this card are
              // BACKLOG — a failed injection and an unconfirmed order are as old
              // as they are — so a day word here would be the same lie the
              // sidebar's 待办 block was renamed to avoid.
              <p className="px-[18px] py-6 text-[13px] text-muted">
                {t("todosEmpty")}
              </p>
            ) : (
              <ul>
                {todos.map((todo) => (
                  <li
                    key={todo.key}
                    className="flex items-center gap-3 border-b border-[#F4F0EC] px-[18px] py-3.5 last:border-b-0"
                    // The exact moment on Madrid's clock, as the heartbeat rows
                    // carry it — hung off the ROW and keyed on `at`, not on the
                    // age chip. Both kinds of row have an `at`; only the failure
                    // rows have a chip, so on the chip this title was dead code
                    // for the 待确认 line, whose `at` was computed and thrown
                    // away.
                    title={todo.at ? t("bridge.at", { time: todo.at }) : undefined}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-brand"
                    />
                    {todo.href ? (
                      <Link href={todo.href} className="min-w-0 flex-1 text-[13px]">
                        {todo.text}
                      </Link>
                    ) : (
                      <span className="min-w-0 flex-1 text-[13px]">{todo.text}</span>
                    )}
                    {todo.age && (
                      <span className="shrink-0 text-[11.5px] text-muted">
                        {todo.age}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* The card's own count, in the footer shape the queue uses
                (`pedidos/page.tsx:916-926`). This was the ONE card here with no
                figure of its own: `FAILED_LIMIT` truncates in silence, so twelve
                failures drew five rows and nothing on the card said so.
                Deliberately outside the ternary above, because the case worth
                drawing is the one where they disagree — a failed LIST read next
                to a live COUNT now renders 暂无待办 beside 共 3 单, a contradiction
                somebody can SEE, which is the A4 precedent (a visible
                disagreement beats a confident lie). When the count itself did
                not arrive nothing extra renders at all and the funnel's own
                bridge_failed dash is the signal.

                It counts FAILURES only. The 待确认 row below them is a different
                query and is not in this total — which is why the footer sits
                under a list that can be one row longer than the number it
                prints. */}
            {bridgeFailedCount !== null && bridgeFailedCount > 0 && (
              <p className="border-t border-[#F4F0EC] px-[18px] py-3.5 text-xs text-muted">
                <span>{t("queueTotal", { n: bridgeFailedCount })}</span>
                {bridgeFailedCount > FAILED_LIMIT && (
                  <>
                    {" · "}
                    {/* 最早, not the queue's 最新: this list is ordered oldest
                        first, so what is on screen is the front of the backlog
                        and not the top of it. */}
                    <span>{t("todoShowing", { m: FAILED_LIMIT })}</span>
                  </>
                )}
              </p>
            )}
          </section>
        </div>
      </div>

      {/* THE HEARTBEAT STAYS. The mockup has no such panel and this portal has
          no substitute for it: it is the one place in the product that says
          whether orders are reaching Wingest at all (decision 4). Everything
          below is the card this page shipped with — the same derivation, the
          same four tones, the same deployed / not-deployed branches, the same
          counts, sample, notes and hints. Only the shell is restyled: `CARD` →
          `ADMIN_CARD`, and the header to the 15px/bold the three cards above it
          use. */}
      <section className={`${ADMIN_CARD} mt-[18px]`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[#EDE9E5] px-5 py-4">
          <h2 className="text-[15px] font-bold">{t("bridge.title")}</h2>
          <p className="text-xs text-muted">{t("bridge.subtitle")}</p>
        </div>

        <div className="px-5 py-[18px]">
          {deployed ? (
            <ul className="space-y-3">
              {statuses.map((status) => {
                const state = bridgeStateKey(status);
                const { value, unit } = relativeAge(status.ageMs ?? 0);
                return (
                  <li
                    key={status.job}
                    className="border-t border-border pt-3 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t(`bridge.jobs.${status.job}`)}</span>
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-xs ${TONE_CLASS[status.tone]}`}
                      >
                        {t(`bridge.state.${state}`)}
                      </span>
                      {state === "failed" && status.code ? (
                        <code className="text-xs text-muted">{status.code}</code>
                      ) : null}
                      <span
                        className="ml-auto text-xs text-muted"
                        // The exact moment on Madrid's clock, because the machine
                        // that wrote it runs on China time.
                        title={
                          status.lastRunAt
                            ? t("bridge.at", {
                                time: formatMadridTime(status.lastRunAt, locale),
                              })
                            : undefined
                        }
                      >
                        {status.ageMs === null
                          ? t("bridge.never")
                          : relative.format(-value, unit)}
                      </span>
                    </div>

                    {/* The numbers, not just the badge: only `injected 3` says
                        orders are reaching Wingest, and only `markFailed 1` names
                        the thing somebody has to go and fix. */}
                    {status.counts.length > 0 ? (
                      <p className="mt-1 text-xs text-muted">
                        {status.counts
                          .map(
                            (count) =>
                              `${countLabel(status.job, count.key)} ${count.value ?? DASH}`,
                          )
                          .join(" · ")}
                      </p>
                    ) : null}

                    {status.sample.length > 0 ? (
                      <p className="mt-1 break-words text-xs text-muted">
                        {t("bridge.sample")}: {status.sample.join(", ")}
                      </p>
                    ) : null}

                    {status.notes.map((note) => (
                      <p key={note.key} className="mt-1 break-words text-xs text-muted">
                        {countLabel(status.job, note.key)}: {note.value}
                      </p>
                    ))}

                    {state === "ok" ? null : (
                      <p className="mt-1 text-xs text-muted">{t(`bridge.hint.${state}`)}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-md px-1.5 py-0.5 text-xs ${TONE_CLASS.warn}`}>
                {t("bridge.notDeployed")}
              </span>
              <p className="text-xs text-muted">{t("bridge.notDeployedHint")}</p>
            </div>
          )}
        </div>
      </section>
    </StaffShell>
  );
}
