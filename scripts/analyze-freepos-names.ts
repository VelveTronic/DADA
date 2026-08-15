/**
 * Ground the bilingual name-split rule in the real snapshot.
 * Usage: pnpm dlx tsx scripts/analyze-freepos-names.ts  (read-only, no DB)
 *
 * Scripts import library code relatively (like scripts/create-user.ts): the
 * standalone tsx runner does not resolve the "@/" tsconfig alias.
 */
import { readFileSync } from "node:fs";
import { parseFreeposImportSnapshot } from "../src/lib/catalog/freepos";

const rows = parseFreeposImportSnapshot(readFileSync("data/freepos/products.json"));
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]/;

let both = 0;
let zhOnly = 0;
let esOnly = 0;
let name2 = 0;
let duanhuo = 0;

/** Shape of a mixed name: which script the first/last run uses, and how many runs. */
const shapes = new Map<string, number>();
const samples: string[] = [];
const shapeSamples = new Map<string, string[]>();

/** Split a name into maximal runs of "zh" / "es" (neutral chars glue to the previous run). */
function runs(name: string): { lang: "zh" | "es"; text: string }[] {
  const out: { lang: "zh" | "es"; text: string }[] = [];
  for (const char of name) {
    const lang = CJK.test(char) ? "zh" : LATIN.test(char) ? "es" : null;
    const last = out[out.length - 1];
    if (lang === null) {
      if (last) last.text += char;
      continue;
    }
    if (last && last.lang === lang) last.text += char;
    else out.push({ lang, text: char });
  }
  return out.map((run) => ({ ...run, text: run.text.trim() }));
}

/** Every prefix shape freepos uses to mark a product dead, with its exact text. */
const UNAVAILABLE_PREFIX = /^[(（]?\s*(?:断货|取消)\s*[)）]?\s*[-–—:：]?\s*/;
const prefixes = new Map<string, number>();
const name2Values: string[] = [];

for (const row of rows) {
  const name = (row["名称"] ?? "").trim();
  if (row["名称2"]) {
    name2++;
    name2Values.push(`${row["编号"]} => ${JSON.stringify(row["名称2"])}`);
  }
  if (/^断货/.test(name)) duanhuo++;
  const prefix = name.match(UNAVAILABLE_PREFIX)?.[0];
  if (prefix) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  const hasCjk = CJK.test(name);
  const hasLatin = LATIN.test(name);
  if (hasCjk && hasLatin) {
    both++;
    const parts = runs(name);
    const shape = parts.map((part) => part.lang).join(">");
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    const bucket = shapeSamples.get(shape) ?? [];
    if (bucket.length < 8) bucket.push(name);
    shapeSamples.set(shape, bucket);
    if (samples.length < 40) samples.push(name);
  } else if (hasCjk) {
    zhOnly++;
  } else {
    esOnly++;
  }
}

console.log({ total: rows.length, both, zhOnly, esOnly, name2, duanhuo });

console.log("\n--- unavailable name prefixes (availability lives here, not in the 断货 column) ---");
let unavailable = 0;
for (const [prefix, count] of [...prefixes.entries()].sort((a, b) => b[1] - a[1])) {
  unavailable += count;
  console.log(`${String(count).padStart(4)}  ${JSON.stringify(prefix)}`);
}
console.log(`${String(unavailable).padStart(4)}  TOTAL`);

console.log("\n--- 名称2 values (is it a second name?) ---");
console.log(name2Values.join("\n") || "(none)");

const ordered = [...shapes.entries()].sort((a, b) => b[1] - a[1]);
console.log("\n--- run shapes in mixed names (zh/es alternation) ---");
for (const [shape, count] of ordered) {
  console.log(`${String(count).padStart(4)}  ${shape}`);
}

console.log("\n--- head language of mixed names ---");
let esHead = 0;
let zhHead = 0;
for (const [shape, count] of ordered) {
  if (shape.startsWith("es")) esHead += count;
  else zhHead += count;
}
console.log({ esHead, zhHead });

console.log("\n--- samples per shape ---");
for (const [shape, count] of ordered.slice(0, 8)) {
  console.log(`\n[${shape}] x${count}`);
  for (const sample of shapeSamples.get(shape) ?? []) console.log(`  ${sample}`);
}

console.log("\n--- first 40 mixed names ---");
console.log(samples.join("\n"));
