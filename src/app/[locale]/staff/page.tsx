import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { GLASS_CARD } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import {
  bridgeCountLabelKey,
  bridgeStateKey,
  deriveBridgeStatuses,
  formatMadridTime,
  relativeAge,
  type BridgeJob,
  type BridgeTone,
} from "@/lib/bridge-status";
import { createServerSupabase } from "@/lib/supabase/server";
import { canManageUsers } from "@/lib/user-admin";

export const dynamic = "force-dynamic";

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

export default async function StaffHome({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");

  const sections = [
    { href: `/${locale}/staff/pedidos`, label: t("ordersQueue") },
    { href: `/${locale}/staff/productos`, label: t("products") },
    // The same condition as the shell's nav entry, from the same role: a card
    // to a page that would only redirect back here is worse than no card.
    ...(canManageUsers(staffUser.role)
      ? [{ href: `/${locale}/staff/usuarios`, label: t("usersAdmin") }]
      : []),
  ];

  // The ordinary session client, not the service-role one: `bridge_status`
  // grants `authenticated` a SELECT that RLS gates to staff, which is exactly
  // what this caller is. The admin client would also work and would cost more
  // than it buys — it throws when `SUPABASE_SERVICE_ROLE_KEY` is absent, and a
  // status card must never be the reason the whole staff home 500s and takes
  // the links to the order queue with it.
  const supabase = await createServerSupabase();
  const { data: heartbeats, error } = await supabase
    .from("bridge_status")
    .select("job, last_run_at, ok, detail");
  // A failed query renders the same "nothing has ever reported" state as an
  // empty table. It is the honest thing to show — we know nothing either way —
  // and the reason lands in the server log rather than on a staff screen.
  if (error) console.error("staff bridge_status query:", error);

  const statuses = deriveBridgeStatuses(heartbeats ?? [], new Date());
  // "Nothing has EVER written here" is a different message from "one job is
  // quiet": it means the bundle is not on the server, or no scheduled task was
  // ever created. Rows for jobs this build does not know do not count as
  // deployment — `deriveBridgeStatuses` ignores them, so this reads the derived
  // views rather than the raw result set.
  const deployed = statuses.some((status) => status.freshness !== "missing");

  const relative = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "es-ES", {
    numeric: "auto",
  });
  /**
   * The label for one count, looked up under ITS OWN job: `injected` means
   * "written into Wingest" for `orders` and "waiting for an albarán" for
   * `albaran-sync`. A key with no label falls back to the raw key.
   */
  const countLabel = (job: BridgeJob, key: string): string => {
    const labelKey = bridgeCountLabelKey(job, key);
    return labelKey ? t(`bridge.counts.${labelKey}`) : key;
  };

  return (
    <AppShell
      locale={locale}
      nav="staff"
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>
      <nav className="mt-6">
        <ul className="grid gap-4 sm:grid-cols-2">
          {sections.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className={`${GLASS_CARD} flex items-center justify-between gap-4 p-5 font-medium transition-colors hover:border-brand hover:text-brand-ink`}
              >
                {section.label}
                <span aria-hidden="true" className="text-brand-ink">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className={`${GLASS_CARD} mt-6 p-5`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="font-medium">{t("bridge.title")}</h2>
          <p className="text-xs text-muted">{t("bridge.subtitle")}</p>
        </div>

        {deployed ? (
          <ul className="mt-4 space-y-3">
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
                            `${countLabel(status.job, count.key)} ${count.value ?? "—"}`,
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
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={`rounded-md px-1.5 py-0.5 text-xs ${TONE_CLASS.warn}`}>
              {t("bridge.notDeployed")}
            </span>
            <p className="text-xs text-muted">{t("bridge.notDeployedHint")}</p>
          </div>
        )}
      </section>
    </AppShell>
  );
}
