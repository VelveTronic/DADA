# DADA Portal — Plan 02: Freepos Import Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the 2976-SKU freepos snapshot into `public.products` (bilingual names, availability, weighed flags, variant selection — NO prices), and deliver the Wingest price-export path that later fills the six real price tiers.

**Architecture:** Pure transform layer (TDD) on top of the existing strict parsing boundary `src/lib/catalog/freepos.ts` → idempotent service-role import script → one real cloud import run → a read-only PowerShell export the OWNER runs on the ERP server to produce a prices CSV, merged by a second script. Prices from freepos are never written (only 5/2976 rows are non-zero garbage); price columns stay NULL until the Wingest merge, so `create_order`'s `NO_PRICE` gate blocks ordering until real prices exist — by design.

**Tech Stack:** TypeScript (tsx scripts), vitest 4 (`--maxWorkers=1`), Supabase service-role client (`scripts/` pattern like `create-user.ts`), PowerShell 5.1 for the ERP-side export.

**Context for the implementer (read first):**
- Repo `F:\DADA Distribucion\DADA`, branch `main`. Read `CLAUDE.md` (conventions) before coding. Gate: `pnpm lint; pnpm typecheck; pnpm test; pnpm build` all exit 0 before every commit.
- Existing parsing boundary: `src/lib/catalog/freepos.ts` — `parseFreeposImportSnapshot(bytes)` returns `FreeposImportRow[]` (14 projected columns, strict UTF-8, header-uniqueness enforced) and `toFreeposSkuPricing(row)` (SKU split + cents + iva). Existing helpers: `src/lib/catalog/sku.ts` (`parseSku`), `src/lib/money.ts`. Do not weaken these; build on top.
- Data: `data/freepos/products.json` (2976 rows). Known facts: `名称2` empty in 2974/2976 rows (zh+es mixed inside `名称`); `断货` column is all zeros — availability lives ONLY in a `断货` NAME PREFIX; `售价…售价6` ≈ all zero (5 non-zero, garbage); `App隐藏` marks app-hidden products; SKU variants share a base (e.g. `100-034A/B/C`), 418 multi-variant groups, largest 26.
- DB target columns (`public.products`): `codart` (unique, `= base_sku || variant_suffix`, btrim'd), `base_sku`, `variant_suffix`, `is_current_variant` (partial unique per base_sku — importer MUST demote the whole group before promoting one), `name jsonb` (check: object with `zh` or `es`), `unit` (default `'UNIDAD'`; real units come with the Wingest merge), `is_weighed`, `is_available`, `is_erp_excluded` (leave default false), `iva_rate` (check: 4|10|21), `price_1_cents..price_6_cents` (NULLABLE — leave NULL in Task 3), `image_url` (leave NULL), `erp_synced_at`, `sort_order`. `categories` requires `erp_code NOT NULL` — this plan creates NO categories; `products.category_id` stays NULL (search-first UI; category browse arrives with the Wingest sync which has real familias).
- Supabase: cloud project `gudiykhngonoqsjoigza`. Scripts use `.env.local` (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). If `SUPABASE_SERVICE_ROLE_KEY` is absent at run time, the script must fail with a clear message — the OWNER sets it locally; never commit it.
- Shell PowerShell 5.1: chain with `;`, never `&&`. Windows paths quoted.

---

### Task 1: Transform layer — bilingual split, availability, variant selection (TDD)

**Files:**
- Create: `scripts/analyze-freepos-names.ts` (throwaway analysis, committed for reproducibility)
- Create: `src/lib/catalog/import.ts`
- Create: `src/lib/catalog/import.test.ts`

- [ ] **Step 1: Ground the name-split rule in the real data.** Write `scripts/analyze-freepos-names.ts`:

```ts
/** Usage: pnpm dlx tsx scripts/analyze-freepos-names.ts  (read-only, no DB) */
import { readFileSync } from "node:fs";
import { parseFreeposImportSnapshot } from "@/lib/catalog/freepos";

const rows = parseFreeposImportSnapshot(readFileSync("data/freepos/products.json"));
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let both = 0, zhOnly = 0, esOnly = 0, name2 = 0, duanhuo = 0;
const samples: string[] = [];
for (const r of rows) {
  const n = r["名称"] ?? "";
  if (r["名称2"]) name2++;
  if (/^断货/.test(n.trim())) duanhuo++;
  const hasCjk = CJK.test(n);
  const hasLatin = /[A-Za-z]/.test(n);
  if (hasCjk && hasLatin) { both++; if (samples.length < 40) samples.push(n); }
  else if (hasCjk) zhOnly++;
  else esOnly++;
}
console.log({ total: rows.length, both, zhOnly, esOnly, name2, duanhuo });
console.log(samples.join("\n"));
```

Run it: `pnpm dlx tsx scripts/analyze-freepos-names.ts`. Study the 40 mixed samples. The DEFAULT split rule below assumes the dominant pattern is `中文段 [latin/es tail]`; if the samples contradict it (es before zh, heavy interleaving), adapt the rule minimally, keep the contract, and paste 20 before/after examples in your report.

- [ ] **Step 2: Write failing tests `src/lib/catalog/import.test.ts`** — use REAL names you saw in Step 1 for at least 6 of the cases (replace the representative literals below with real ones if they differ):

```ts
import { describe, expect, it } from "vitest";
import {
  splitBilingualName,
  toProductRecord,
  selectCurrentVariants,
  type ImportedProduct,
} from "./import";

describe("splitBilingualName", () => {
  it("splits zh head + es tail", () => {
    expect(splitBilingualName("圆糯米 ARROZ GLUTINOSO 1KG")).toEqual({
      zh: "圆糯米",
      es: "ARROZ GLUTINOSO 1KG",
    });
  });
  it("keeps size/units glued to the zh segment with the zh name", () => {
    expect(splitBilingualName("老干妈辣椒酱280g SALSA LAOGANMA")).toEqual({
      zh: "老干妈辣椒酱280g",
      es: "SALSA LAOGANMA",
    });
  });
  it("zh only", () => {
    expect(splitBilingualName("五花肉")).toEqual({ zh: "五花肉", es: null });
  });
  it("es only", () => {
    expect(splitBilingualName("ACEITE GIRASOL 5L")).toEqual({ zh: null, es: "ACEITE GIRASOL 5L" });
  });
  it("strips whitespace and separators", () => {
    expect(splitBilingualName("  白菜 - COL CHINA  ")).toEqual({ zh: "白菜", es: "COL CHINA" });
  });
});

describe("toProductRecord", () => {
  const base = {
    编号: "4-007",
    名称: "断货 圆糯米 ARROZ GLUTINOSO",
    名称2: null,
    售价: "0", 售价2: "0", 售价3: null, 售价4: null, 售价5: null, 售价6: null,
    税率: "0.21",
    断货: "0",
    需称重: "0",
    App隐藏: "0",
    "APP多规格(逗号分隔)": null,
  } as const;

  it("断货 name prefix → unavailable + stripped name", () => {
    const p = toProductRecord({ ...base });
    expect(p.is_available).toBe(false);
    expect(p.name.zh).toBe("圆糯米");
    expect(p.name.es).toBe("ARROZ GLUTINOSO");
  });
  it("App隐藏 → unavailable", () => {
    const p = toProductRecord({ ...base, 名称: "圆糯米 ARROZ", App隐藏: "1" });
    expect(p.is_available).toBe(false);
  });
  it("需称重 → is_weighed", () => {
    const p = toProductRecord({ ...base, 名称: "五花肉", 需称重: "1" });
    expect(p.is_weighed).toBe(true);
  });
  it("prices are NEVER emitted from freepos", () => {
    const p = toProductRecord({ ...base, 名称: "圆糯米", 售价: "3.50" });
    expect(p).not.toHaveProperty("price_1_cents");
  });
  it("iva normalizes fraction to percent", () => {
    expect(toProductRecord({ ...base, 名称: "圆糯米" }).iva_rate).toBe(21);
  });
  it("name must survive the DB shape check", () => {
    const p = toProductRecord({ ...base, 名称: "ACEITE" });
    expect(p.name.zh ?? p.name.es).toBeTruthy();
  });
});

describe("selectCurrentVariants", () => {
  const mk = (codart: string, available: boolean): ImportedProduct =>
    ({ ...toProductRecord({
      编号: codart, 名称: "测试 TEST", 名称2: null,
      售价: null, 售价2: null, 售价3: null, 售价4: null, 售价5: null, 售价6: null,
      税率: "0.21", 断货: "0", 需称重: "0", App隐藏: available ? "0" : "1",
      "APP多规格(逗号分隔)": null,
    }) });

  it("prefers the available variant", () => {
    const out = selectCurrentVariants([mk("100-034A", false), mk("100-034B", true)]);
    expect(out.find((p) => p.codart === "100-034B")!.is_current_variant).toBe(true);
    expect(out.find((p) => p.codart === "100-034A")!.is_current_variant).toBe(false);
  });
  it("prefers the suffixless base among available", () => {
    const out = selectCurrentVariants([mk("100-034", true), mk("100-034A", true)]);
    expect(out.find((p) => p.codart === "100-034")!.is_current_variant).toBe(true);
  });
  it("falls back to lowest suffix when none available", () => {
    const out = selectCurrentVariants([mk("100-034B", false), mk("100-034A", false)]);
    expect(out.find((p) => p.codart === "100-034A")!.is_current_variant).toBe(true);
    expect(out.filter((p) => p.is_current_variant)).toHaveLength(1);
  });
  it("single products are trivially current", () => {
    const out = selectCurrentVariants([mk("4-007", true)]);
    expect(out[0].is_current_variant).toBe(true);
  });
  it("exactly one current per group, always", () => {
    const out = selectCurrentVariants([
      mk("A6-092A", true), mk("A6-092B", true), mk("A6-092C", false), mk("9-001", true),
    ]);
    const groups = new Map<string, number>();
    for (const p of out) if (p.is_current_variant) groups.set(p.base_sku, (groups.get(p.base_sku) ?? 0) + 1);
    expect([...groups.values()].every((n) => n === 1)).toBe(true);
  });
});
```

- [ ] **Step 3: Run `pnpm test`** — expect the new file to FAIL (module not found).

- [ ] **Step 4: Implement `src/lib/catalog/import.ts`:**

```ts
import type { FreeposImportRow } from "@/lib/catalog/freepos";
import { parseSku } from "@/lib/catalog/sku";

const CJK_CHAR = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3000-\\u303f\\uff0c\\uff01\\uff08\\uff09";
/** Leading run that contains at least one CJK char: zh segment (sizes like 280g stay glued). */
const ZH_HEAD = new RegExp(`^([${CJK_CHAR}][${CJK_CHAR}0-9a-zA-Z%.·/]*)`);
const UNAVAILABLE_PREFIX = /^断货\s*[:：\-]?\s*/;

export interface BilingualName {
  zh: string | null;
  es: string | null;
}

/**
 * Freepos stores both languages in one field, dominant pattern "中文段 SPANISH TAIL".
 * zh = the leading CJK run (digits/units glued to it stay with zh);
 * es = whatever non-empty remainder follows. Separator punctuation is trimmed.
 */
export function splitBilingualName(raw: string): BilingualName {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return { zh: null, es: null };
  const m = cleaned.match(ZH_HEAD);
  if (!m) return { zh: null, es: cleaned };
  const zh = m[1].trim();
  const rest = cleaned
    .slice(m[1].length)
    .replace(/^[\s\-–—:：·,，/|]+/, "")
    .trim();
  return { zh: zh || null, es: rest || null };
}

export interface ImportedProduct {
  codart: string;
  base_sku: string;
  variant_suffix: string;
  is_current_variant: boolean;
  name: { zh?: string; es?: string };
  unit: string;
  is_weighed: boolean;
  is_available: boolean;
  iva_rate: number;
}

function flag(value: string | null): boolean {
  return value !== null && value.trim() !== "" && value.trim() !== "0";
}

function ivaPercent(value: string | null): number {
  if (value === null) throw new Error("Freepos tax rate is required");
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) throw new Error(`Invalid Freepos tax rate: ${value}`);
  const percent = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  if (![4, 10, 21].includes(percent)) throw new Error(`Unsupported Freepos tax rate: ${value}`);
  return percent;
}

/**
 * One freepos row → one products record. NO price fields on purpose: freepos
 * prices are garbage (5/2976 non-zero); tiers stay NULL until the Wingest merge,
 * and create_order's NO_PRICE gate keeps un-priced products un-orderable.
 * is_current_variant defaults true here; selectCurrentVariants finalizes it.
 */
export function toProductRecord(row: FreeposImportRow): ImportedProduct {
  const codart = row["编号"]?.trim();
  if (!codart) throw new Error("Freepos product number is required");
  const { base, suffix } = parseSku(codart);

  const rawName = (row["名称"] ?? "").trim();
  if (!rawName) throw new Error(`Freepos name is required for ${codart}`);
  const unavailableByName = UNAVAILABLE_PREFIX.test(rawName);
  const { zh, es } = splitBilingualName(rawName.replace(UNAVAILABLE_PREFIX, ""));
  const es2 = row["名称2"]?.trim() || null;
  const name: { zh?: string; es?: string } = {};
  if (zh) name.zh = zh;
  if (es2 ?? es) name.es = (es2 ?? es)!;
  if (!name.zh && !name.es) throw new Error(`Unsplittable Freepos name for ${codart}: ${rawName}`);

  return {
    codart,
    base_sku: base,
    variant_suffix: suffix,
    is_current_variant: true,
    name,
    unit: "UNIDAD",
    is_weighed: flag(row["需称重"]),
    is_available: !unavailableByName && !flag(row["App隐藏"]),
    iva_rate: ivaPercent(row["税率"]),
  };
}

/**
 * Exactly one current variant per base_sku:
 * available beats unavailable → suffixless beats suffixed → lowest suffix wins.
 * Deterministic and total; ties cannot survive.
 */
export function selectCurrentVariants(products: ImportedProduct[]): ImportedProduct[] {
  const byBase = new Map<string, ImportedProduct[]>();
  for (const p of products) {
    const g = byBase.get(p.base_sku);
    if (g) g.push(p);
    else byBase.set(p.base_sku, [p]);
  }
  const rank = (p: ImportedProduct): string =>
    `${p.is_available ? 0 : 1}|${p.variant_suffix === "" ? 0 : 1}|${p.variant_suffix}`;
  for (const group of byBase.values()) {
    const winner = [...group].sort((a, b) => rank(a).localeCompare(rank(b)))[0];
    for (const p of group) p.is_current_variant = p === winner;
  }
  return products;
}
```

- [ ] **Step 5: `pnpm test`** — all pass (existing 20 + new). If the Step 1 analysis contradicted the default split rule, your adapted rule must still pass the CONTRACT tests (one current per group; name always has zh or es; 断货 stripped).

- [ ] **Step 6: Full gate; commit** — `git add -A; git commit -m "feat(import): freepos transform layer - bilingual split, availability, variant selection"`

---

### Task 2: Idempotent import script

**Files:**
- Create: `scripts/import-freepos.ts`

- [ ] **Step 1: Write `scripts/import-freepos.ts`:**

```ts
/**
 * Import the freepos snapshot into public.products. Idempotent by codart.
 * NEVER writes price columns (they stay NULL until the Wingest price merge).
 * Usage: pnpm dlx tsx scripts/import-freepos.ts [--dry-run]
 * Requires .env.local: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseFreeposImportSnapshot } from "@/lib/catalog/freepos";
import { selectCurrentVariants, toProductRecord } from "@/lib/catalog/import";
import type { Database } from "@/lib/supabase/database.types";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");
const db = createClient<Database>(url, key, { auth: { persistSession: false } });

const rows = parseFreeposImportSnapshot(readFileSync("data/freepos/products.json"));
const anomalies: string[] = [];
const records = [];
for (const row of rows) {
  try {
    records.push(toProductRecord(row));
  } catch (e) {
    anomalies.push(e instanceof Error ? e.message : String(e));
  }
}
selectCurrentVariants(records);

const seen = new Set<string>();
const deduped = records.filter((r) => {
  if (seen.has(r.codart)) {
    anomalies.push(`duplicate codart in snapshot: ${r.codart}`);
    return false;
  }
  seen.add(r.codart);
  return true;
});

const groups = new Set(deduped.map((r) => r.base_sku));
const report = {
  snapshotRows: rows.length,
  importable: deduped.length,
  anomalies: anomalies.length,
  variantGroups: groups.size,
  unavailable: deduped.filter((r) => !r.is_available).length,
  weighed: deduped.filter((r) => r.is_weighed).length,
  currents: deduped.filter((r) => r.is_current_variant).length,
};
console.log(JSON.stringify(report, null, 2));
if (anomalies.length) console.log("ANOMALIES:\n" + anomalies.join("\n"));
if (dryRun) process.exit(0);

// Two-phase write honoring the partial unique index products_one_current_variant:
// phase 1 upserts every record with is_current_variant=false (whole groups demoted),
// phase 2 promotes exactly the winners. Chunked to stay under PostgREST limits.
const CHUNK = 500;
async function upsertChunk(chunk: typeof deduped, demote: boolean) {
  const payload = chunk.map((r) => ({
    codart: r.codart,
    base_sku: r.base_sku,
    variant_suffix: r.variant_suffix,
    is_current_variant: demote ? false : r.is_current_variant,
    name: r.name,
    unit: r.unit,
    is_weighed: r.is_weighed,
    is_available: r.is_available,
    iva_rate: r.iva_rate,
    erp_synced_at: null,
  }));
  const { error } = await db.from("products").upsert(payload, { onConflict: "codart" });
  if (error) throw new Error(`upsert failed: ${error.message}`);
}

for (let i = 0; i < deduped.length; i += CHUNK) {
  await upsertChunk(deduped.slice(i, i + CHUNK), true);
}
const winners = deduped.filter((r) => r.is_current_variant);
for (let i = 0; i < winners.length; i += CHUNK) {
  await upsertChunk(winners.slice(i, i + CHUNK), false);
}

const { count } = await db.from("products").select("*", { count: "exact", head: true });
console.log(`products table now holds ${count} rows`);
```

- [ ] **Step 2: Dry-run against the snapshot** — `pnpm dlx tsx scripts/import-freepos.ts --dry-run`. Expected: report JSON with `snapshotRows: 2976`, `currents === variantGroups`, anomalies listed (a handful is acceptable — names that fail to split, duplicate codarts; each anomaly line must be understandable). Paste the report in your task report. If anomalies exceed ~30, stop and report DONE_WITH_CONCERNS with examples instead of importing garbage.

- [ ] **Step 3: Full gate; commit** — `git add -A; git commit -m "feat(import): idempotent freepos import script with two-phase variant promotion"`

---

### Task 3: Real import run against the cloud

Precondition: `SUPABASE_SERVICE_ROLE_KEY` present in `.env.local`. If it is missing, report BLOCKED (the owner must fetch it from the Supabase dashboard → Project Settings → API; it is never committed).

- [ ] **Step 1:** `pnpm dlx tsx scripts/import-freepos.ts` (real run). Expected: report + `products table now holds ~2900+ rows`.
- [ ] **Step 2: Verify via SQL** (Supabase MCP execute_sql, plain SELECTs):
  - `select count(*) total, count(*) filter (where is_current_variant) currents, count(*) filter (where not is_available) unavailable, count(*) filter (where is_weighed) weighed, count(*) filter (where price_1_cents is not null) priced from public.products;` — expect priced = 0, currents = number of distinct base_sku.
  - `select count(*) from public.products p where not exists (select 1 from public.products c where c.base_sku = p.base_sku and c.is_current_variant);` — expect 0 (every group has a current).
  - `select codart, name from public.products order by random() limit 10;` — spot-check 10 bilingual splits by eye; paste them.
  - Re-run the import script a second time — expect identical counts (idempotency proof).
- [ ] **Step 3: Commit nothing (no repo change) — report the verification outputs.**

---

### Task 4: Wingest price/unit export + merge script

**Files:**
- Create: `scripts/wingest/export-prices.ps1` (the OWNER runs this on the ERP server — we never drive the ERP ourselves)
- Create: `scripts/import-wingest-prices.ts`

- [ ] **Step 1: `scripts/wingest/export-prices.ps1`:**

```powershell
# Read-only export of Wingest price tiers + units for the DADA portal.
# RUN ON SERVER (PowerShell). Output: prices.csv (UTF-8) next to this script.
# Uses the dada_bridge SQL login; set $PW in the session first.
$conn = "Server=localhost,50352;User ID=dada_bridge;Password=$PW;Initial Catalog=wgdemo;Encrypt=False;TrustServerCertificate=True;Connect Timeout=15"
$cn = New-Object System.Data.SqlClient.SqlConnection($conn); $cn.Open()
$c = $cn.CreateCommand()
$c.CommandText = @"
SELECT RTRIM(CODART) AS codart,
       PREVENA, PREVENB, PREVENC, PREVEND, PREVENE, PREVENF,
       RTRIM(UNIDAD) AS unidad, UNILOT
FROM articulo
"@
$rd = $c.ExecuteReader()
$rows = New-Object System.Collections.Generic.List[string]
$rows.Add("codart,p1,p2,p3,p4,p5,p6,unidad,unilot")
while ($rd.Read()) {
  $vals = 0..8 | ForEach-Object { ('' + $rd[$_]).Trim().Replace(',', '.') }
  $rows.Add(($vals -join ','))
}
$rd.Close(); $cn.Close()
$out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "prices.csv"
[System.IO.File]::WriteAllLines($out, $rows, (New-Object System.Text.UTF8Encoding($false)))
"exported $($rows.Count - 1) articles -> $out"
```

This script is READ-ONLY against the production DB (single SELECT, no locks beyond a read). It is delivered for the owner to run on SERVER; this task does NOT run it.

- [ ] **Step 2: `scripts/import-wingest-prices.ts`:**

```ts
/**
 * Merge Wingest price tiers + units into public.products by codart.
 * Zero prices become NULL (a zero tier in Wingest means "no price", and a 0-cent
 * price would make create_order sell for free). Products absent from the CSV are
 * left untouched. Usage: pnpm dlx tsx scripts/import-wingest-prices.ts <prices.csv>
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { centsFromEuros } from "@/lib/money";
import type { Database } from "@/lib/supabase/database.types";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: pnpm dlx tsx scripts/import-wingest-prices.ts <prices.csv>");
  process.exit(1);
}
const db = createClient<Database>(url, key, { auth: { persistSession: false } });

function euroToCentsOrNull(text: string): number | null {
  if (!text) return null;
  const euros = Number(text);
  if (!Number.isFinite(euros) || euros < 0) throw new Error(`bad price: ${text}`);
  const cents = centsFromEuros(euros);
  return cents === 0 ? null : cents;
}

const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
const header = lines.shift();
if (header !== "codart,p1,p2,p3,p4,p5,p6,unidad,unilot") {
  console.error(`unexpected header: ${header}`);
  process.exit(1);
}

let matched = 0, missing = 0, updated = 0;
const missingList: string[] = [];
for (const line of lines) {
  const [codart, p1, p2, p3, p4, p5, p6, unidad, unilot] = line.split(",");
  const patch = {
    price_1_cents: euroToCentsOrNull(p1),
    price_2_cents: euroToCentsOrNull(p2),
    price_3_cents: euroToCentsOrNull(p3),
    price_4_cents: euroToCentsOrNull(p4),
    price_5_cents: euroToCentsOrNull(p5),
    price_6_cents: euroToCentsOrNull(p6),
    unit: unidad?.trim() || "UNIDAD",
    units_per_case: unilot && Number(unilot) > 0 ? Number(unilot) : null,
    erp_synced_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("products")
    .update(patch)
    .eq("codart", codart.trim())
    .select("codart");
  if (error) throw new Error(`update ${codart}: ${error.message}`);
  if (data.length === 0) {
    missing++;
    if (missingList.length < 20) missingList.push(codart);
  } else {
    matched++;
    updated += data.length;
  }
}
console.log(JSON.stringify({ csvRows: lines.length, matched, updated, notInPortal: missing }, null, 2));
if (missingList.length) console.log("first not-in-portal codarts:", missingList.join(", "));
```

- [ ] **Step 3: Full gate; commit** — `git add -A; git commit -m "feat(import): wingest price export (owner-run) + merge script, zero prices become NULL"`
- [ ] **Step 4:** The real CSV run happens when the owner executes the export on SERVER and hands back `prices.csv` — out of scope for this task; the deliverable is the tested tooling.

---

## Follow-up plans (separate documents, NOT part of this plan)

- **Plan 02b — Catalog UI:** customer catalog page on `products_priced` (search zh/es/codart, availability greying, favorites, repeat-last-order), staff product admin (availability toggle, variant switcher via service role + demote-promote).
- **Plan 03 — Cart & checkout:** cart store, delivery-date cutoff (Europe/Madrid), `create_order` wiring with client_token, order history; staff confirmation queue UI on the existing `staff_confirm_order`/`staff_cancel_order` RPCs.
- **Plan 04 — Wingest bridge service:** SERVER-side poller on `bridge_claim_confirmed` (lease + claim token), pedido injector v4 (Madrid dates via `AT TIME ZONE`, pedclica+pedclicah dedup on portal order id, 4-char ERP user), albarán number write-back, nightly price re-sync, ops runbook.
