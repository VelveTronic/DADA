/**
 * What every job hands back to `main.ts`.
 *
 * Two fields, because the CLI has exactly two things to do with a finished run:
 * decide an exit code from `ok`, and print/heartbeat `counts`.
 *
 * `ok` means THE RUN COMPLETED — not "nothing went wrong". A per-order failure
 * in the orders job leaves `ok` true and shows up as a non-zero `failed` count:
 * the order stays `processing`, its lease expires, and the next run re-claims
 * it. Exiting non-zero there would make Task Scheduler's history red every time
 * one order out of twenty had a bad codart, which is exactly how a red light
 * stops meaning anything. `ok` is false only when the run itself could not be
 * done: no config, no lock, no database, no Supabase.
 */
/**
 * A string ARRAY is allowed alongside the scalars for one case: price-sync's
 * sample of codarts the portal has no product for. It travels to `bridge_status`
 * as jsonb, where the staff card can render the codarts as a list, and through
 * `log.ts`, which JSON-encodes anything non-scalar onto the one summary line.
 */
export type JobCounts = Record<
  string,
  number | string | boolean | null | readonly string[]
>;

export interface JobResult {
  ok: boolean;
  counts: JobCounts;
}
