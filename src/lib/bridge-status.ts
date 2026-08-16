/**
 * Reading the bridge's heartbeat.
 *
 * The bridge runs on a Windows box in the customer's office, behind a router
 * nothing can reach in. Its ONLY channel back is one upserted row per job in
 * `bridge_status` (see `src/bridge/main.ts`), so the staff card is a piece of
 * remote diagnosis: it has to tell "healthy", "busy", "broken" and — the one
 * that costs money — "nobody has heard from this job in hours" apart, from four
 * columns and a jsonb blob.
 *
 * Everything here is pure and takes `now` as an argument. The three judgements
 * below are the reason:
 *
 * 1. **Silence is not health.** A run that never happened writes nothing, so the
 *    row keeps whatever the last successful run left there. A green card on a
 *    two-day-old timestamp is the exact failure this whole feature exists to
 *    prevent, which is why freshness is computed BEFORE the row's own `ok` is
 *    even looked at.
 * 2. **Busy is not failure.** `orders` is scheduled every minute and holds a
 *    lockfile; a run that overlaps its predecessor exits with `ok:false` and
 *    `detail.code = 'LOCK_HELD'`. That is the lock doing its job. Painted red it
 *    would cry wolf every day — and, worse, a blocked run's heartbeat can
 *    OVERWRITE a success written seconds earlier, so the red would appear on a
 *    bridge that is working perfectly. It self-heals on the next unblocked run.
 * 3. **Counts are the diagnosis.** A green badge says the program ran; only
 *    `claimed=3 injected=3` says orders are reaching Wingest, and only
 *    `markFailed=1` names the thing a human must go and fix. The detail blob is
 *    unpacked rather than reduced to a colour.
 */

/** The three scheduled jobs, in the order the card lists them. */
export const BRIDGE_JOBS = ["orders", "albaran-sync", "price-sync"] as const;

export type BridgeJob = (typeof BRIDGE_JOBS)[number];

export function isBridgeJob(value: string): value is BridgeJob {
  return (BRIDGE_JOBS as readonly string[]).includes(value);
}

/**
 * How long each job may stay quiet before its row stops being believable.
 *
 * Each is its schedule plus room for one bad night, not a tight bound: the point
 * is to catch "this task is not running at all", not to page someone because a
 * price sync started four minutes late.
 *
 * - `orders` fires every minute (`/sc minute /mo 1`), so ten minutes is ten
 *   missed runs — well past a slow run and well short of a delivery being late.
 * - `albaran-sync` is hourly; three hours is three misses.
 * - `price-sync` is daily at 06:30 Madrid, so the window has to clear a full day
 *   plus the hour Madrid's DST changes can move it — 26 hours, which goes amber
 *   in the late morning after a missed night rather than at 06:31.
 */
export const BRIDGE_STALE_MS: Record<BridgeJob, number> = {
  orders: 10 * 60_000,
  "albaran-sync": 3 * 60 * 60_000,
  "price-sync": 26 * 60 * 60_000,
};

/** The heartbeat row as it comes out of PostgREST (`detail` is jsonb). */
export interface BridgeStatusRow {
  job: string;
  last_run_at: string;
  ok: boolean;
  detail: unknown;
}

/** Did we hear from this job recently enough to believe what it said? */
export type BridgeFreshness = "fresh" | "stale" | "missing";

/** What the last run we DID hear about reported. */
export type BridgeOutcome = "ok" | "busy" | "failed" | "unknown";

/** Which of the four visual treatments the row gets. */
export type BridgeTone = "good" | "busy" | "warn" | "bad";

/** A numeric count out of `detail`. `null` is "the job could not count it". */
export interface BridgeCount {
  key: string;
  value: number | null;
}

/** A text field out of `detail` — an error message, not a number. */
export interface BridgeNote {
  key: string;
  value: string;
}

export interface BridgeStatusView {
  job: BridgeJob;
  freshness: BridgeFreshness;
  outcome: BridgeOutcome;
  tone: BridgeTone;
  /** The row's timestamp, or null when there is no usable one. */
  lastRunAt: string | null;
  /** Age in ms; null with no timestamp, and never negative (see below). */
  ageMs: number | null;
  /** `detail.code` — the machine token an operator greps the log for. */
  code: string | null;
  counts: BridgeCount[];
  notes: BridgeNote[];
  /** `detail.notInPortalSample` — codarts price-sync found no product for. */
  sample: string[];
}

/**
 * Which count keys each job emits, and therefore which label belongs to it.
 *
 * Scoped PER JOB rather than one flat key→label map, because the same key means
 * different things in different jobs: `injected` in an `orders` run counts
 * orders this run just wrote into Wingest, while `injected` in an
 * `albaran-sync` run counts orders still WAITING for an albarán. A flat map
 * labelled the second one 已注入 and told staff four orders had just been
 * injected in an hour when none had.
 *
 * A key not listed here — one added to a job after this build shipped — is
 * rendered under its raw key rather than dropped: an unlabelled number is still
 * a number worth seeing, and a wrong label is worse than a bare one.
 */
const COUNT_LABEL_KEYS = {
  orders: ["claimed", "injected", "recovered", "markFailed", "failed"],
  "albaran-sync": ["injected", "matched", "marked"],
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
} as const satisfies Record<BridgeJob, readonly string[]>;

/** `<job>.<key>` — the message key under `staff.bridge.counts`. */
export type BridgeCountLabelKey = {
  [J in BridgeJob]: `${J}.${(typeof COUNT_LABEL_KEYS)[J][number]}`;
}[BridgeJob];

/**
 * The label key for one count of one job, or null if this build has no label.
 *
 * The assertion is the narrowing TypeScript cannot do for itself: `key` arrives
 * as a string out of jsonb, and the line above it has just proved the pair is
 * one of the literal combinations the type enumerates.
 */
export function bridgeCountLabelKey(
  job: BridgeJob,
  key: string,
): BridgeCountLabelKey | null {
  const known: readonly string[] = COUNT_LABEL_KEYS[job];
  return known.includes(key) ? (`${job}.${key}` as BridgeCountLabelKey) : null;
}

/** The lock told this run to stand down — the one `ok:false` that is not a fault. */
export const LOCK_HELD = "LOCK_HELD";

/** How many sample codarts the card will show, matching the bridge's own cap. */
const MAX_SAMPLE = 20;

/** Keys that are rendered as their own thing, not as a count chip. */
const SPECIAL_KEYS = new Set(["code", "notInPortalSample"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Split `detail` into the three things the card renders: numbers, text, and the
 * unmatched-codart sample.
 *
 * Insertion order is preserved because every job builds its counts in the order
 * a human reads them (`claimed`, then what happened to those claims). Booleans
 * become notes rather than chips — no job emits one today, and a `true` in a row
 * of numbers would read as a quantity.
 */
export function readBridgeDetail(detail: unknown): {
  code: string | null;
  counts: BridgeCount[];
  notes: BridgeNote[];
  sample: string[];
} {
  const record = asRecord(detail);
  if (!record) return { code: null, counts: [], notes: [], sample: [] };

  const code = typeof record.code === "string" ? record.code : null;
  const counts: BridgeCount[] = [];
  const notes: BridgeNote[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (SPECIAL_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      counts.push({ key, value });
    } else if (value === null) {
      // `fullyUnpriced: null` means PostgREST withheld the count — a fact worth
      // showing as "—" rather than a zero the operator would read as a catalog
      // that just emptied itself.
      counts.push({ key, value: null });
    } else if (typeof value === "string" && value) {
      notes.push({ key, value });
    } else if (typeof value === "boolean") {
      notes.push({ key, value: String(value) });
    }
  }

  const rawSample = record.notInPortalSample;
  const sample = Array.isArray(rawSample)
    ? rawSample.filter((item): item is string => typeof item === "string").slice(0, MAX_SAMPLE)
    : [];

  return { code, counts, notes, sample };
}

/**
 * One row (or its absence) → everything the card needs to draw it.
 *
 * The order of the decisions is the whole design:
 *
 * - No row, or a timestamp that does not parse → `missing`. Nothing has ever
 *   written here, which is what a bridge that was never deployed, whose
 *   `bridge.env` is broken (that path writes NO heartbeat at all — there is no
 *   service key to write one with), or whose scheduled task was never created
 *   all look like.
 * - Older than this job's window → `stale`, whatever the row says. The outcome
 *   is still reported alongside, because "last thing we heard was a failure,
 *   nine hours ago" and "it was fine, nine hours ago" call for different next
 *   steps.
 * - `ok:false` with `code = LOCK_HELD` → `busy`, never a failure. See the note
 *   at the top of this file.
 * - Any other `ok:false` (`RUN_FAILED` from a job that threw, `LOCK_FAILED` from
 *   an unwritable lock directory, anything future) → `failed`.
 *
 * A NEGATIVE age — a row stamped in the future — is clamped to zero and treated
 * as fresh. The ERP server's clock runs China time and has been adjusted before;
 * a skew must not turn a working bridge amber, and the same fail-safe choice is
 * made in `lock.ts`.
 */
export function deriveBridgeStatus(
  job: BridgeJob,
  row: BridgeStatusRow | null | undefined,
  now: Date,
): BridgeStatusView {
  const base = {
    job,
    lastRunAt: null,
    ageMs: null,
    code: null,
    counts: [] as BridgeCount[],
    notes: [] as BridgeNote[],
    sample: [] as string[],
  };

  if (!row) {
    return { ...base, freshness: "missing", outcome: "unknown", tone: "warn" };
  }

  const parsed = Date.parse(row.last_run_at);
  const detail = readBridgeDetail(row.detail);
  if (Number.isNaN(parsed)) {
    return {
      ...base,
      ...detail,
      freshness: "missing",
      outcome: "unknown",
      tone: "warn",
    };
  }

  const ageMs = Math.max(0, now.getTime() - parsed);
  const fresh = ageMs < BRIDGE_STALE_MS[job];
  const outcome: BridgeOutcome = row.ok
    ? "ok"
    : detail.code === LOCK_HELD
      ? "busy"
      : "failed";

  return {
    ...base,
    ...detail,
    lastRunAt: row.last_run_at,
    ageMs,
    freshness: fresh ? "fresh" : "stale",
    outcome,
    // A failure outranks silence: both need attention, and the failure names
    // itself. Everything else that is not fresh is amber, not green.
    tone: outcome === "failed" ? "bad" : !fresh ? "warn" : outcome === "busy" ? "busy" : "good",
  };
}

/**
 * The ONE word the card puts on the badge — freshness and outcome collapsed in
 * the order that decides what a human should do next.
 *
 * A failure names itself first, because it is actionable whenever it happened.
 * Otherwise silence wins over the stale row's own verdict: "nothing has run" is
 * the more urgent fact than what the last run that did happen thought.
 *
 * The five keys are message keys (`staff.bridge.state.*`) and match `tone`
 * one-for-one, so a badge can never say 正常 in amber.
 */
export type BridgeStateKey = "ok" | "busy" | "failed" | "stale" | "missing";

export function bridgeStateKey(view: BridgeStatusView): BridgeStateKey {
  if (view.outcome === "failed") return "failed";
  if (view.freshness === "missing") return "missing";
  if (view.freshness === "stale") return "stale";
  return view.outcome === "busy" ? "busy" : "ok";
}

/**
 * All three jobs in card order, whether or not the table has a row for each.
 *
 * Driven by `BRIDGE_JOBS` rather than by what the query returned, because the
 * missing rows are the interesting ones: a `price-sync` that was never scheduled
 * has no row, and a card built from the result set alone would simply not
 * mention it.
 */
export function deriveBridgeStatuses(
  rows: readonly BridgeStatusRow[],
  now: Date,
): BridgeStatusView[] {
  const byJob = new Map(rows.map((row) => [row.job, row]));
  return BRIDGE_JOBS.map((job) => deriveBridgeStatus(job, byJob.get(job) ?? null, now));
}

/**
 * An age in ms as the largest whole unit that fits, for `Intl.RelativeTimeFormat`.
 *
 * Split out from the formatting so the thresholds are testable without asking a
 * test to know what "3 分钟前" looks like in a given ICU build. Days are the
 * ceiling: a bridge silent for more than a day is a problem measured in "go and
 * look", not in weeks.
 */
export function relativeAge(ageMs: number): { value: number; unit: "second" | "minute" | "hour" | "day" } {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return { value: seconds, unit: "second" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: minutes, unit: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: "hour" };
  return { value: Math.floor(hours / 24), unit: "day" };
}

/**
 * The exact moment, on MADRID's clock.
 *
 * The timestamp is written by a server whose Windows clock is set to China time,
 * and read by staff in Spain. `timestamptz` makes that a non-problem in the
 * database — but only if every rendering names the zone, so nobody has to
 * remember which end of the wire a number came from.
 */
export function formatMadridTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "es-ES", {
    timeZone: "Europe/Madrid",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
