/**
 * Seed public.categories from the freepos category tree and backfill
 * public.products.category_id from the freepos snapshot. Idempotent: categories
 * upsert on erp_code, products are matched by codart.
 *
 * Usage: pnpm seed:categories [--dry-run]
 * --dry-run parses the seed table and the snapshot and reports without reading
 * .env.local or touching the database; it prints ONE JSON document. A write run
 * requires .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 * and prints TWO: the seed/backfill report, then the post-run diagnostics.
 * Progress and sample lists go to stderr so both documents stay pipeable.
 *
 * Scripts import library code relatively, like scripts/create-user.ts — house
 * style, not a tooling limit (tsx does resolve the "@/" alias).
 */
import { readFileSync } from "node:fs";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const USAGE = "Usage: pnpm seed:categories [--dry-run]";
const SNAPSHOT_PATH = "data/freepos/products.json";
const CODART_COLUMN = "编号";
const CATEGORY_COLUMN = "类别";
/** codart is short, so a chunk this size stays far inside the PostgREST URL limit. */
const CHUNK = 200;
const SAMPLE = 20;

/**
 * The freepos category tree, transcribed from the freepos admin. Columns:
 * erp_code | zh name | zh parent | sort | es name | es parent.
 *
 * erp_code is the freepos category id as text and the only unique key here:
 * 71 and 83 really do share the name 摆台铭牌 under different parents.
 * The parent is a LABEL, not a self-reference — see the parent_label migration.
 */
const CATEGORY_SEED = `
36|comabu系列|comabu系列|004|Serie Comabu|Serie Comabu
80|MAKRO|MAKRO||MAKRO|MAKRO
33|pascoma 系列|pascoma 系列|018|Serie Pascoma|Serie Pascoma
76|TAKOMAMA专用系列|TAKOMAMA专用系列||Serie TAKOMAMA|Serie TAKOMAMA
79|巴铁食品|巴铁食品||Alimentos pakistaníes|Alimentos pakistaníes
83|摆台铭牌|餐厅用品||Placas de mesa|Menaje de restaurante
61|办公文具|餐厅用品|0004|Papelería de oficina|Menaje de restaurante
63|餐具筷子|餐厅用品|0001|Cubiertos y palillos|Menaje de restaurante
67|餐厅摆设|餐厅用品||Decoración de restaurante|Menaje de restaurante
7|餐厅用品|餐厅用品|027|Menaje de restaurante|Menaje de restaurante
64|壶具杯类|餐厅用品|0002|Jarras y vasos|Menaje de restaurante
62|药品药箱|餐厅用品|0005|Botiquín|Menaje de restaurante
66|纸制品类|餐厅用品|0003|Productos de papel|Menaje de restaurante
40|厨房用具|厨房用具|026|Utensilios de cocina|Utensilios de cocina
52|打折商品|打折商品|032|Ofertas|Ofertas
24|调料salsa类|调料salsa类|017|Salsas y condimentos|Salsas y condimentos
55|亚洲调料|调料salsa类|015|Condimentos asiáticos|Salsas y condimentos
32|干果 aceituna 类|干果类|012|Frutos secos y aceitunas|Frutos secos
41|工作服类|工作服类|036|Ropa de trabajo|Ropa de trabajo
23|罐头类|罐头类|013|Conservas|Conservas
6|各类蔬菜|果蔬类|001|Verduras|Frutas y verduras
73|时令水果|果蔬类||Fruta de temporada|Frutas y verduras
30|华夏调料|华夏调料|016|Condimentos Huaxia|Condimentos Huaxia
46|火锅店专用|火锅店专用|021|Especial hot pot|Especial hot pot
31|加工厂系列|加工厂系列|003|Serie obrador|Serie obrador
21|中式冷冻点心类|冷冻点心类|007|Dim sum congelado|Dim sum congelado
20|冷冻海鲜|冷冻海鲜|006|Marisco congelado|Marisco congelado
18|冷冻甜品|冷冻甜品|010|Postres congelados|Postres congelados
28|冷冻油炸，沙拉类|冷冻油炸|008|Fritos y ensaladas congelados|Congelados fritos
58|PULPA系列|冷冻油炸，沙拉类|024|Serie pulpa|Fritos y ensaladas congelados
25|米面油|米面油|011|Arroz, harina y aceite|Arroz, harina y aceite
54|PatoSalvaje餐具|盘子类|031|Vajilla Pato Salvaje|Vajilla
70|simply thai泰餐盘子|盘子类||Vajilla Simply Thai|Vajilla
85|长盘子|盘子类||Platos alargados|Vajilla
78|回转餐盘|盘子类||Platos para cinta giratoria|Vajilla
53|火锅餐具|盘子类|030|Vajilla hot pot|Vajilla
37|盘子，碟子|盘子类|029|Platos y platillos|Vajilla
57|齐齐哈里烤肉餐具|盘子类|032|Vajilla barbacoa Qiqihar|Vajilla
84|碗|盘子类||Cuencos|Vajilla
34|披萨用品|披萨用品|005|Artículos para pizza|Artículos para pizza
59|齐齐哈里烤肉|齐齐哈里烤肉|021|Barbacoa Qiqihar|Barbacoa Qiqihar
27|清洁化学品|清洁用品|025|Química de limpieza|Limpieza
74|清洁用品用具|清洁用品||Útiles de limpieza|Limpieza
13|肉蛋奶类|肉蛋奶类|002|Carne, huevos y lácteos|Carne, huevos y lácteos
35|寿司用品|寿司用品|020|Artículos para sushi|Artículos para sushi
77|泰餐店专用|泰餐店专用||Especial restaurante tailandés|Especial restaurante tailandés
22|甜品及糖类|甜品及糖类|019|Dulces y azúcares|Dulces y azúcares
45|外卖用品|外卖用品|028|Envases para llevar|Envases para llevar
81|电器|五金电器||Electrodomésticos|Ferretería y electro
82|五金|五金电器||Ferretería|Ferretería y electro
60|五金电器|五金电器|038|Ferretería y electro|Ferretería y electro
51|新品推荐|新品推荐|000|Novedades|Novedades
26|亚洲食品|亚洲货|014|Alimentación asiática|Productos asiáticos
14|酒精类酒水|饮料酒水类|023|Bebidas alcohólicas|Bebidas
75|饮料和水类|饮料酒水类||Refrescos y agua|Bebidas
48|员工住家用品类|员工住家用品类|037|Artículos para el personal|Artículos para el personal
71|摆台铭牌|桌椅与装饰品||Placas de mesa|Mobiliario y decoración
42|餐厅桌椅类|桌椅与装饰品|033|Mesas y sillas|Mobiliario y decoración
69|果蔬模型|桌椅与装饰品||Réplicas de frutas|Mobiliario y decoración
65|海洋球系列|桌椅与装饰品|0006|Bolas de piscina|Mobiliario y decoración
38|装饰品|桌椅与装饰品|034|Decoración|Mobiliario y decoración
`;

type CategorySeed = {
  erp_code: string;
  name: { zh: string; es: string };
  parent_label: { zh: string; es: string };
  sort_order: number;
};

/**
 * On the { data, error } path PostgREST hands back a PLAIN OBJECT, not the
 * PostgrestError class it is typed as — that one is only constructed when
 * throwOnError is set. So it fails `instanceof Error` and stringifies to
 * "[object Object]"; flatten the fields an operator needs by hand instead.
 */
function describeDbError(error: PostgrestError): string {
  return [
    error.message,
    error.code && `code ${error.code}`,
    error.details,
    error.hint,
  ]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Fail CLOSED on anything that is not exactly --dry-run. A typo ("--dryrun")
 * must never be read as "no flag given" and silently run the REAL seed.
 */
function parseArgs(argv: string[]): boolean {
  const unknownArgs = argv.filter((arg) => arg !== "--dry-run");
  if (unknownArgs.length) {
    console.error(`Unknown argument(s): ${unknownArgs.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

function parseCategorySeed(table: string): CategorySeed[] {
  const seeds = table
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const cells = line.split("|").map((cell) => cell.trim());
      if (cells.length !== 6) {
        throw new Error(
          `seed row ${index + 1} has ${cells.length} cells, expected 6: ${line}`,
        );
      }
      const [erpCode, zhName, zhParent, sort, esName, esParent] = cells;
      if (!erpCode || !zhName || !esName) {
        throw new Error(`seed row ${index + 1} is missing a key field: ${line}`);
      }
      return {
        erp_code: erpCode,
        name: { zh: zhName, es: esName },
        parent_label: { zh: zhParent, es: esParent },
        // The freepos sort strings are zero-padded and NOT unique across the
        // tree ("004" and "0004" both land on 4); the chip row breaks the ties
        // by display name. A blank one sorts first, like freepos shows it.
        sort_order: Number.parseInt(sort, 10) || 0,
      };
    });

  // A duplicate erp_code would be silently collapsed by the upsert, leaving a
  // category the backfill still resolves — to the wrong row.
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (seen.has(seed.erp_code)) {
      throw new Error(`duplicate erp_code in the seed table: ${seed.erp_code}`);
    }
    seen.add(seed.erp_code);
  }
  return seeds;
}

/**
 * The freepos export carries TWO "类别" columns: the FIRST holds the category id
 * of the product, the second is empty in every row. parseFreeposImportSnapshot
 * refuses ambiguous columns on purpose (importing the wrong one is silent and
 * unrecoverable), so this reads the column positionally here rather than
 * weakening that contract for everyone.
 */
function readCategoryAssignments(
  path: string,
): { codart: string; erpCode: string | null }[] {
  const document: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !document ||
    typeof document !== "object" ||
    !Array.isArray((document as { header?: unknown }).header) ||
    !Array.isArray((document as { rows?: unknown }).rows)
  ) {
    throw new Error(`${path} must contain header and rows arrays`);
  }
  const { header, rows } = document as { header: unknown[]; rows: unknown[] };

  const codartIndex = header.indexOf(CODART_COLUMN);
  const categoryIndex = header.indexOf(CATEGORY_COLUMN);
  if (codartIndex < 0) throw new Error(`no "${CODART_COLUMN}" column in ${path}`);
  if (categoryIndex < 0) {
    throw new Error(`no "${CATEGORY_COLUMN}" column in ${path}`);
  }

  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== header.length) {
      throw new Error(`row ${index + 1} does not match the header width`);
    }
    const codart = String(row[codartIndex] ?? "").trim();
    if (!codart) throw new Error(`row ${index + 1} has no ${CODART_COLUMN}`);
    const raw = row[categoryIndex];
    const erpCode =
      raw === null || raw === undefined ? "" : String(raw).trim();
    return { codart, erpCode: erpCode || null };
  });
}

function serviceClient() {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

/**
 * The awaiting body lives in a function because the package is CJS (no "type":
 * "module"), and tsx/esbuild refuse to emit top-level await into CJS output —
 * it is a transform-time error, so bare `await` here would break the script
 * outright, --dry-run and argument validation included.
 */
async function main(): Promise<void> {
  const dryRun = parseArgs(process.argv.slice(2));
  const seeds = parseCategorySeed(CATEGORY_SEED);
  const known = new Set(seeds.map((seed) => seed.erp_code));
  const assignments = readCategoryAssignments(SNAPSHOT_PATH);

  // Group by category BEFORE writing: one PATCH per category with a
  // codart=in.(...) list is 61 round trips instead of one per product.
  const byCategory = new Map<string, string[]>();
  const unknownCategories = new Map<string, number>();
  const seenCodart = new Set<string>();
  let duplicateRows = 0;
  let withoutCategory = 0;
  const withoutCategorySample: string[] = [];
  for (const { codart, erpCode } of assignments) {
    // First row wins, exactly like the importer's dedupe — so a duplicated
    // codart gets the category of the row that became the product.
    if (seenCodart.has(codart)) {
      duplicateRows++;
      continue;
    }
    seenCodart.add(codart);
    if (!erpCode) {
      withoutCategory++;
      if (withoutCategorySample.length < SAMPLE) withoutCategorySample.push(codart);
      continue;
    }
    if (!known.has(erpCode)) {
      unknownCategories.set(erpCode, (unknownCategories.get(erpCode) ?? 0) + 1);
      continue;
    }
    const group = byCategory.get(erpCode);
    if (group) group.push(codart);
    else byCategory.set(erpCode, [codart]);
  }

  const assignable = [...byCategory.values()].reduce(
    (total, group) => total + group.length,
    0,
  );
  const report: Record<string, unknown> = {
    snapshotRows: assignments.length,
    duplicateRows,
    categoriesInSeed: seeds.length,
    categoriesUsedBySnapshot: byCategory.size,
    // Seeded but unused: a real category that simply has no product today.
    categoriesWithNoProducts: seeds
      .filter((seed) => !byCategory.has(seed.erp_code))
      .map((seed) => seed.erp_code),
    productsAssignable: assignable,
    productsWithoutCategory: withoutCategory,
    // Freepos ids the seed table does not describe. Their products keep the
    // category_id they already have (NULL on a first run) — guessing a category
    // is worse than an empty filter chip.
    unknownCategoryIds: Object.fromEntries(
      [...unknownCategories].sort((a, b) => b[1] - a[1]),
    ),
  };

  if (dryRun) {
    report.dryRun = true;
    console.log(JSON.stringify(report, null, 2));
    if (withoutCategorySample.length) {
      console.error(
        `first uncategorized codarts: ${withoutCategorySample.join(", ")}`,
      );
    }
    return;
  }

  const db = serviceClient();
  const { error: upsertError } = await db
    .from("categories")
    .upsert(seeds, { onConflict: "erp_code" });
  if (upsertError) {
    throw new Error(`categories upsert failed: ${describeDbError(upsertError)}`);
  }

  const { data: categoryRows, error: readError } = await db
    .from("categories")
    .select("id, erp_code");
  if (readError) {
    throw new Error(`categories read failed: ${describeDbError(readError)}`);
  }
  const idByCode = new Map(categoryRows.map((row) => [row.erp_code, row.id]));

  let matched = 0;
  let notInPortal = 0;
  const notInPortalSample: string[] = [];
  let done = 0;
  for (const [erpCode, codarts] of byCategory) {
    const categoryId = idByCode.get(erpCode);
    // Upsert + read just ran; a missing id means the two disagree, and writing
    // NULL over 2900 rows because of it is not an acceptable fallback.
    if (categoryId === undefined) {
      throw new Error(`category ${erpCode} is absent after the upsert`);
    }
    const hit = new Set<string>();
    for (let i = 0; i < codarts.length; i += CHUNK) {
      const chunk = codarts.slice(i, i + CHUNK);
      const { data, error } = await db
        .from("products")
        .update({ category_id: categoryId })
        .in("codart", chunk)
        .select("codart");
      // Name the category and the codart window: a mid-run failure leaves the
      // categories before it already backfilled, and re-running is safe (the
      // backfill is idempotent by codart), but the operator has to be able to
      // see how far it got before deciding.
      if (error) {
        throw new Error(
          `backfill failed for category ${erpCode} on codarts ` +
            `${chunk[0]}..${chunk[chunk.length - 1]}: ${describeDbError(error)}`,
        );
      }
      for (const row of data) hit.add(row.codart);
    }
    matched += hit.size;
    for (const codart of codarts) {
      if (hit.has(codart)) continue;
      notInPortal++;
      if (notInPortalSample.length < SAMPLE) notInPortalSample.push(codart);
    }
    done++;
    // Progress on stderr so the JSON documents on stdout stay pipeable.
    if (done % 20 === 0) {
      console.error(`... ${done}/${byCategory.size} categories backfilled`);
    }
  }

  // Print what the writes did BEFORE asking the database anything else: losing
  // the diagnostics to a network blip must not also lose the only record of the
  // backfill itself.
  report.productsUpdated = matched;
  report.productsNotInPortal = notInPortal;
  console.log(JSON.stringify(report, null, 2));
  if (withoutCategorySample.length) {
    console.error(
      `first uncategorized codarts: ${withoutCategorySample.join(", ")}`,
    );
  }
  if (notInPortalSample.length) {
    console.error(`first not-in-portal codarts: ${notInPortalSample.join(", ")}`);
  }

  // Second document on stdout. A failure here is reported, not thrown: the seed
  // and backfill already succeeded, and exiting non-zero would read as "the
  // catalog has no categories" and invite a pointless re-run.
  const diagnostics: Record<string, unknown> = {};
  try {
    const { count: categoryCount, error: categoryError } = await db
      .from("categories")
      .select("*", { count: "exact", head: true });
    if (categoryError) throw categoryError;
    const { count: categorized, error: categorizedError } = await db
      .from("products")
      .select("*", { count: "exact", head: true })
      .not("category_id", "is", null);
    if (categorizedError) throw categorizedError;
    diagnostics.categoriesInTable = categoryCount;
    diagnostics.productsWithCategoryId = categorized;
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? describeDbError(error as PostgrestError)
        : String(error);
    diagnostics.countError = message;
    console.error(`post-seed diagnostics failed: ${message}`);
  }
  console.log(JSON.stringify(diagnostics, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
