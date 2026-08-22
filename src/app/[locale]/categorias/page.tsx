import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import {
  catalogCategoryHref,
  categoryImageMap,
  type BrowserProductImage,
} from "@/lib/category-browser";
import { groupCategories, hiddenCategoryIds } from "@/lib/categories";
import { perfRun } from "@/lib/perf";
import {
  MAX_SCAN_WINDOWS,
  scanRange,
  scanTruncated,
  scanWindowCount,
} from "@/lib/scan-windows";
import { getSetting } from "@/lib/settings";
import type { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

/**
 * Read enough pictured products to choose one deterministic fallback per
 * visible category. PostgREST caps each response at 1,000 rows, so a single
 * wide range would silently miss later categories in today's ~3,000-product
 * catalogue; the shared bounded window arithmetic makes that cap explicit.
 */
async function scanCategoryProductImages(
  supabase: ServerSupabase,
  categoryIds: readonly number[],
): Promise<{
  rows: BrowserProductImage[];
  total: number;
  truncated: boolean;
}> {
  if (categoryIds.length === 0) return { rows: [], total: 0, truncated: false };

  const rows: BrowserProductImage[] = [];
  let total = 0;
  let windows = 1;

  for (let index = 0; index < windows; index++) {
    const { from, to } = scanRange(index);
    const { data, error, count } = await supabase
      // Customer catalogue reads stay on the priced view. Only the two image
      // fields cross the wire; no tariff column or whole product row does.
      .from("products_priced")
      .select("category_id, image_url", { count: "exact" })
      .eq("is_current_variant", true)
      .in("category_id", [...categoryIds])
      .not("image_url", "is", null)
      // UUID is the stable tie-breaker that keeps offset windows disjoint and
      // makes "any product image" repeatable across renders.
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      console.error("customer category product image scan:", error);
      break;
    }
    rows.push(...(data ?? []));
    if (index === 0) {
      total = count ?? 0;
      windows = scanWindowCount(total);
    }
  }

  return { rows, total, truncated: scanTruncated(total) };
}

/**
 * 分类 — the image-led index of the same 一级/二级 tree shown in the catalogue
 * rail. The tree, visibility filter and locale-aware ordering are shared with
 * `/catalogo`; this page is another view of those rules, not another copy.
 */
export default async function CategoriesPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/categorias`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("categories");

  // The profile gate, category rows, caller-owned visibility grants and global
  // price switch are independent RLS-protected reads, so they share round one.
  const [portalUser, categoryResult, grantResult, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step(
      "categories",
      supabase
        .from("categories")
        .select(
          "id, name, sort_order, parent_label, visibility, image_url",
        )
        .eq("is_active", true),
    ),
    perf.step(
      "categoryGrants",
      supabase.from("category_companies").select("category_id"),
    ),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);

  if (categoryResult.error) {
    console.error("customer categories query:", categoryResult.error);
  }
  if (grantResult.error) {
    console.error("customer categories grants query:", grantResult.error);
  }

  // The same fail-closed grant rule as the catalogue rail: if the caller's
  // allowlist cannot be read, selected-only shelves are not shown.
  const allowedIds = new Set(
    (grantResult.data ?? []).map((row) => row.category_id),
  );
  const allCategories = categoryResult.data ?? [];
  const hiddenIds = new Set(hiddenCategoryIds(allCategories, allowedIds));
  const categories = allCategories.filter((row) => !hiddenIds.has(row.id));

  // Only categories without an edited cover need a product fallback. At first
  // rollout this is most of the list; as staff save category covers, the scan
  // naturally narrows and eventually disappears.
  const fallbackIds = categories
    .filter((category) => !category.image_url?.trim())
    .map((category) => category.id);
  const imageScan = await perf.step(
    "categoryImages",
    scanCategoryProductImages(supabase, fallbackIds),
  );
  if (imageScan.truncated) {
    console.error(
      `customer category image scan truncated at ${imageScan.rows.length} of ${imageScan.total} (ceiling ${MAX_SCAN_WINDOWS} windows)`,
    );
  }

  const images = categoryImageMap(categories, imageScan.rows);
  const tree = groupCategories(categories, locale);
  perf.end();

  const card = (category: (typeof categories)[number] & { label: string }) => {
    const cover = images.get(category.id);
    return (
      <Link
        key={category.id}
        href={catalogCategoryHref(locale, category.id)}
        prefetch={false}
        className="group min-w-0 overflow-hidden rounded-card border border-border bg-surface shadow-sm transition hover:border-brand/40 hover:shadow-md"
      >
        <span className="relative block aspect-square overflow-hidden bg-surface-dim">
          {cover ? (
            <Image
              src={cover}
              alt=""
              fill
              sizes="(min-width: 1024px) 240px, (min-width: 640px) 33vw, 50vw"
              className="object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <Image
              src="/brand/dada-logo.png"
              alt=""
              fill
              sizes="(min-width: 1024px) 240px, (min-width: 640px) 33vw, 50vw"
              className="object-contain p-[24%] opacity-50"
            />
          )}
        </span>
        <span className="block min-h-12 px-3 py-3 text-sm leading-snug font-semibold break-words text-ink group-hover:text-brand-ink">
          {category.label}
        </span>
      </Link>
    );
  };

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      <header className="pt-5 pb-4">
        <h1 className="text-xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("subtitle")}</p>
      </header>

      {tree.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-5 py-12 text-center text-sm text-muted">
          {t("empty")}
        </p>
      ) : (
        <nav aria-label={t("gridLabel")} className="pb-5">
          {/* A group occupies a full outer row and owns a nested grid. That
              boundary matters when it has an odd number of children: the next
              standalone category cannot slip into the last child row and look
              as though it belongs to the group. Standalone rows remain the
              first-level cards themselves, in the same outer grid/order. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
            {tree.map((entry, index) => {
              if (entry.kind === "category") return card(entry.category);
              return (
                <section
                  key={`group:${entry.label}`}
                  className={`col-span-full ${index === 0 ? "mt-1" : "mt-3"}`}
                >
                  <h2 className="border-l-[3px] border-brand pl-2.5 text-sm font-bold text-brand-ink">
                    {entry.label}
                  </h2>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
                    {entry.children.map(card)}
                  </div>
                </section>
              );
            })}
          </div>
        </nav>
      )}
    </AppShell>
  );
}
