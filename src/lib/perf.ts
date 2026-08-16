import { cache } from "react";

/**
 * Where one request's server time went, printed as ONE line when `PERF_LOG=1`.
 *
 * ```text
 * [perf] #7 /zh/catalogo session=0.6 profile=13.9 categories=13.4 settings=13.1 favorites=12.8 products=25.4 total=40.1
 * ```
 *
 * **Read the line as round TRIPS, not as a sum.** Every step is wall time from
 * the moment its request was put on the wire to the moment it came back, so
 * steps that ran together overlap and their numbers add up to far more than
 * `total`. That is the point: `session+profile+…` ≫ `total` is what
 * parallelism looks like from here, and a `total` that equals the sum is a page
 * that queued its queries one behind the other.
 *
 * **It must not change what it measures.** `step()` subscribes to the work it
 * is handed as soon as it is handed it — one microtask, never an `await` — and
 * it does that whether or not logging is on. That matters because a supabase-js
 * query builder sends nothing until something calls its `then`: wrapping one
 * here is what puts it on the wire, so a page may hold a `step()` promise and
 * await it several lines later without its request having waited too, and
 * turning `PERF_LOG` off cannot serialise a page that was parallel with it on.
 *
 * **Off by default, and off means off:** no timer is read, no array is
 * allocated and nothing is written; `step` degrades to `Promise.resolve`.
 *
 * Server-side only by usage (it is called from Server Components and Server
 * Actions) but deliberately NOT marked `server-only`: it holds no secret, uses
 * no server API, and the import would put `src/lib/settings.ts`-style unit tests
 * out of reach for the pure formatter below.
 */

/** One measured segment. `ms` is `NaN` until the segment has come back. */
export interface PerfSpan {
  readonly label: string;
  readonly ms: number;
}

/** The handle a page or an action holds for its own request. */
export interface PerfRun {
  /**
   * Time one awaited segment. Subscribes to `work` now (see the module note),
   * records it under `label`, and hands back a real promise.
   */
  step<T>(label: string, work: PromiseLike<T>): Promise<T>;
  /** Close the request and print its line. Calling it twice prints once. */
  end(): void;
}

/** `PERF_LOG=1` and nothing else. Read per call so a test can stub the env. */
export function perfEnabled(): boolean {
  return process.env.PERF_LOG === "1";
}

/** A number for the line, or `?` for a segment that never came back. */
function ms(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "?";
}

/**
 * The line itself — pure, so the format is pinned by a test rather than by
 * reading the server log and hoping.
 *
 * `id` correlates lines when several requests are in flight at once; 0 leaves
 * it out, which is what the standalone fallback below wants.
 */
export function formatPerfLine(
  route: string,
  spans: readonly PerfSpan[],
  totalMs: number,
  id = 0,
): string {
  const head = id > 0 ? `[perf] #${id}` : "[perf]";
  const steps = spans.map((span) => `${span.label}=${ms(span.ms)}`).join(" ");
  return `${head} ${route}${steps ? ` ${steps}` : ""} total=${ms(totalMs)}`;
}

/** A span while it is still being timed. */
interface MutableSpan {
  readonly label: string;
  ms: number;
}

interface Run {
  readonly id: number;
  readonly route: string;
  readonly startedAt: number;
  readonly spans: MutableSpan[];
  done: boolean;
}

/** Correlation ids. Per process, which is all a log line needs. */
let requests = 0;

/**
 * The run of the CURRENT request, so `guards.ts` can record the two segments it
 * owns without every guard growing a perf parameter.
 *
 * React's `cache` is what makes it per-request: the page's `perfRun` and the
 * guard's `perfStep` are the same render pass, so they see the same object, and
 * two requests being served at once cannot see each other's. Outside a render
 * (a Server Action in some Next versions) `cache` simply does not memoise —
 * `perfStep` notices the empty slot and prints its segment on a line of its own
 * rather than losing it.
 */
const slot = cache((): { run: Run | null } => ({ run: null }));

const NOOP: PerfRun = {
  step: (_label, work) => Promise.resolve(work),
  end: () => {},
};

/** Start timing a request. `route` is what the line is filed under. */
export function perfRun(route: string): PerfRun {
  if (!perfEnabled()) return NOOP;

  const run: Run = {
    id: ++requests,
    route,
    startedAt: performance.now(),
    spans: [],
    done: false,
  };
  slot().run = run;

  return {
    step: (label, work) => record(run, label, work),
    end: () => {
      if (run.done) return;
      run.done = true;
      console.log(
        formatPerfLine(
          run.route,
          run.spans,
          performance.now() - run.startedAt,
          run.id,
        ),
      );
    },
  };
}

/**
 * Time a segment from code that does not hold the run — the auth guards, which
 * every page enters through and none of which should have to be handed a
 * timer to be measurable.
 */
export function perfStep<T>(label: string, work: PromiseLike<T>): Promise<T> {
  if (!perfEnabled()) return Promise.resolve(work);

  const run = slot().run;
  if (run) return record(run, label, work);

  return standalone(label, work);
}

/**
 * Push the span BEFORE awaiting, so the line reads in the order the requests
 * were issued rather than the order they happened to come back — which is what
 * makes a serialised page obvious at a glance. A segment interrupted by a
 * `redirect()` keeps its `NaN` and prints as `?`.
 */
async function record<T>(
  run: Run,
  label: string,
  work: PromiseLike<T>,
): Promise<T> {
  const span: MutableSpan = { label, ms: Number.NaN };
  run.spans.push(span);
  const startedAt = performance.now();
  try {
    return await work;
  } finally {
    span.ms = performance.now() - startedAt;
  }
}

/** No run for this request: report the segment rather than drop it. */
async function standalone<T>(label: string, work: PromiseLike<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work;
  } finally {
    console.log(formatPerfLine(label, [], performance.now() - startedAt));
  }
}
