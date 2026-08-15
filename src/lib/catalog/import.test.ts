import { describe, expect, it } from "vitest";
import {
  splitBilingualName,
  toProductRecord,
  selectCurrentVariants,
  type ImportedProduct,
} from "./import";

// Every literal below marked "real" is copied verbatim from data/freepos/products.json.

describe("splitBilingualName", () => {
  it("splits es head + zh tail (the dominant real shape, 1340/2419 mixed names)", () => {
    expect(splitBilingualName("BROCOLI 6KG POR CAJA 西蓝花")).toEqual({
      zh: "西蓝花",
      es: "BROCOLI 6KG POR CAJA",
    });
  });

  it("splits zh head + es tail", () => {
    expect(splitBilingualName("香菇  3/4cm  3KG/6 BOLSA  SETAS SECA")).toEqual({
      zh: "香菇",
      es: "3/4cm 3KG/6 BOLSA SETAS SECA",
    });
  });

  it("regroups interleaved segments per language, keeping order", () => {
    expect(splitBilingualName("PUERROS  C/APROX 10KG  大葱 POR KILO")).toEqual({
      zh: "大葱",
      es: "PUERROS C/APROX 10KG POR KILO",
    });
    expect(splitBilingualName("TOMATE CHERRY 圣女果西红柿 APROXIMA 6KG")).toEqual({
      zh: "圣女果西红柿",
      es: "TOMATE CHERRY APROXIMA 6KG",
    });
  });

  it("keeps size/units glued to the zh segment with the zh name", () => {
    expect(splitBilingualName("TRIANGULO SAMOSA DE CURRY 咖喱角10/1.2KG")).toEqual({
      zh: "咖喱角10/1.2KG",
      es: "TRIANGULO SAMOSA DE CURRY",
    });
    expect(splitBilingualName("SALSA PICANTE LGM 24/280G 老干妈风味豆豉油辣椒")).toEqual({
      zh: "老干妈风味豆豉油辣椒",
      es: "SALSA PICANTE LGM 24/280G",
    });
  });

  it("keeps latin fragments that live inside a zh token with the zh name", () => {
    expect(splitBilingualName("MIZKAN日本白菊米醋 20L/桶")).toEqual({
      zh: "MIZKAN日本白菊米醋 20L/桶",
      es: null,
    });
  });

  it("zh only", () => {
    expect(splitBilingualName("一次性桌纸")).toEqual({ zh: "一次性桌纸", es: null });
  });

  it("es only", () => {
    expect(splitBilingualName("GINEBRA LARIOS 1L 1C/6UNID")).toEqual({
      zh: null,
      es: "GINEBRA LARIOS 1L 1C/6UNID",
    });
  });

  it("collapses padding whitespace", () => {
    expect(splitBilingualName("BATATA DULCE 番薯      ")).toEqual({
      zh: "番薯",
      es: "BATATA DULCE",
    });
  });

  it("strips separators between the two segments but keeps inner ones", () => {
    expect(splitBilingualName("  白菜 - COL CHINA  ")).toEqual({
      zh: "白菜",
      es: "COL CHINA",
    });
    expect(splitBilingualName("TOCINO GRASA / 5KG APROX 肥肉（白油）")).toEqual({
      zh: "肥肉（白油）",
      es: "TOCINO GRASA / 5KG APROX",
    });
  });

  it("sends a leading letterless token to es", () => {
    expect(splitBilingualName("() 冰鲜鲈鱼 LUBINA FRESCA 8/10 C/10KG (火锅店专用)")).toEqual({
      zh: "冰鲜鲈鱼 (火锅店专用)",
      es: "() LUBINA FRESCA 8/10 C/10KG",
    });
    expect(splitBilingualName("15191 PLATO LARGO 凯旋长条盘25cm 密胺")).toEqual({
      zh: "凯旋长条盘25cm 密胺",
      es: "15191 PLATO LARGO",
    });
  });

  it("empty in, empty out", () => {
    expect(splitBilingualName("   ")).toEqual({ zh: null, es: null });
  });
});

describe("toProductRecord", () => {
  const base = {
    编号: "V-001",
    名称: "BROCOLI 6KG POR CAJA 西蓝花",
    名称2: null,
    售价: "0",
    售价2: "0",
    售价3: null,
    售价4: null,
    售价5: null,
    售价6: null,
    税率: "0.21",
    断货: "0",
    需称重: "0",
    App隐藏: "0",
    "APP多规格(逗号分隔)": null,
  } as const;

  it("splits the SKU into base and variant suffix", () => {
    const p = toProductRecord({ ...base, 编号: "A9-465B" });
    expect(p.codart).toBe("A9-465B");
    expect(p.base_sku).toBe("A9-465");
    expect(p.variant_suffix).toBe("B");
    expect(toProductRecord({ ...base }).variant_suffix).toBe("");
  });

  it("断货 name prefix → unavailable + stripped name", () => {
    const p = toProductRecord({
      ...base,
      编号: "10-016",
      名称: "断货-ARROZ GLUTINOSO NEGRO 5KG 黑米",
    });
    expect(p.is_available).toBe(false);
    expect(p.name.zh).toBe("黑米");
    expect(p.name.es).toBe("ARROZ GLUTINOSO NEGRO 5KG");
  });

  it("bracketed 断货 and 取消 prefixes are unavailable too", () => {
    const paren = toProductRecord({
      ...base,
      名称: "(断货) lomo de vacuno 加工厂牛排 10kg",
    });
    expect(paren.is_available).toBe(false);
    expect(paren.name.es).toBe("lomo de vacuno 10kg");
    expect(paren.name.zh).toBe("加工厂牛排");

    const cancelled = toProductRecord({
      ...base,
      名称: "取消-PAULUS DE TINTO JOVEN  红酒6/75cl",
    });
    expect(cancelled.is_available).toBe(false);
    expect(cancelled.name.es).toBe("PAULUS DE TINTO JOVEN");
  });

  it("停产 (discontinued) prefix is a dead marker too", () => {
    const p = toProductRecord({
      ...base,
      编号: "102-033",
      名称: "停产-ZANAHORIA PICADA RALLADA  C/8KG 冷冻红萝卜丁 ",
    });
    expect(p.is_available).toBe(false);
    expect(p.name.zh).toBe("冷冻红萝卜丁");
    expect(p.name.es).toBe("ZANAHORIA PICADA RALLADA C/8KG");
    expect(`${p.name.zh}${p.name.es}`).not.toContain("停产");
  });

  it("keeps a plain product available", () => {
    expect(toProductRecord({ ...base }).is_available).toBe(true);
  });

  it("App隐藏 → unavailable", () => {
    expect(toProductRecord({ ...base, App隐藏: "1" }).is_available).toBe(false);
  });

  it("需称重 → is_weighed", () => {
    const p = toProductRecord({ ...base, 编号: "101-010", 名称: "PANCETA 五花肉 APROXIMA 5KG ", 需称重: "1" });
    expect(p.is_weighed).toBe(true);
    expect(toProductRecord({ ...base }).is_weighed).toBe(false);
  });

  it("prices are NEVER emitted from freepos", () => {
    const p = toProductRecord({ ...base, 售价: "3.50" });
    expect(Object.keys(p).filter((k) => /cent|price|precio/i.test(k))).toEqual([]);
  });

  it("iva normalizes fraction to percent", () => {
    expect(toProductRecord({ ...base }).iva_rate).toBe(21);
    expect(toProductRecord({ ...base, 税率: "0.04" }).iva_rate).toBe(4);
    expect(toProductRecord({ ...base, 税率: "0.1" }).iva_rate).toBe(10);
    expect(toProductRecord({ ...base, 税率: "21" }).iva_rate).toBe(21);
    expect(() => toProductRecord({ ...base, 税率: "0.07" })).toThrow(/tax rate/);
    // An already-percent value is never rounded into a legal rate.
    expect(() => toProductRecord({ ...base, 税率: "20.7" })).toThrow(/tax rate/);
  });

  it("ignores 名称2: freepos stores a number there, not a second name", () => {
    const p = toProductRecord({
      ...base,
      编号: "100-061",
      名称: "冷冻三文鱼片 FILETE DE SALMON CONGELADO  C/15KG aprox",
      名称2: "3",
    });
    expect(p.name.es).toBe("FILETE DE SALMON CONGELADO C/15KG aprox");
    expect(p.name.zh).toBe("冷冻三文鱼片");
  });

  it("name must survive the DB shape check", () => {
    const p = toProductRecord({ ...base, 名称: "GINEBRA LARIOS 1L 1C/6UNID" });
    expect(p.name.zh ?? p.name.es).toBeTruthy();
    expect(p.name).not.toHaveProperty("zh");
  });

  it("defaults unit and current-variant, and rejects unusable rows", () => {
    const p = toProductRecord({ ...base });
    expect(p.unit).toBe("UNIDAD");
    expect(p.is_current_variant).toBe(true);
    expect(() => toProductRecord({ ...base, 编号: "  " })).toThrow(/product number/);
    expect(() => toProductRecord({ ...base, 名称: "  " })).toThrow(/name is required/);
    expect(() => toProductRecord({ ...base, 名称: "断货-" })).toThrow(/Unsplittable/);
  });

  it("rejects a punctuation-only name instead of importing it", () => {
    // H-54514, H-21905, H-34808, H-35012 and H-34608 are all named ".".
    expect(() => toProductRecord({ ...base, 编号: "H-34808", 名称: "." })).toThrow(
      "Unsplittable Freepos name for H-34808: .",
    );
    expect(() => toProductRecord({ ...base, 名称: "- / -" })).toThrow(/Unsplittable/);
  });
});

describe("selectCurrentVariants", () => {
  const mk = (codart: string, available: boolean): ImportedProduct =>
    toProductRecord({
      编号: codart,
      名称: available
        ? "绿色海洋球C/350U BOLA DE PLASTICO GREEN"
        : "断货-粉色海洋球C/350U BOLA DE PLASTICO ROSA",
      名称2: null,
      售价: null,
      售价2: null,
      售价3: null,
      售价4: null,
      售价5: null,
      售价6: null,
      税率: "0.21",
      断货: "0",
      需称重: "0",
      App隐藏: "0",
      "APP多规格(逗号分隔)": null,
    });

  it("prefers the available variant", () => {
    const out = selectCurrentVariants([mk("A9-465A", false), mk("A9-465B", true)]);
    expect(out.find((p) => p.codart === "A9-465B")!.is_current_variant).toBe(true);
    expect(out.find((p) => p.codart === "A9-465A")!.is_current_variant).toBe(false);
  });

  it("prefers the suffixless base among available", () => {
    const out = selectCurrentVariants([mk("V-008", true), mk("V-008K", true)]);
    expect(out.find((p) => p.codart === "V-008")!.is_current_variant).toBe(true);
    expect(out.find((p) => p.codart === "V-008K")!.is_current_variant).toBe(false);
  });

  it("an unavailable suffixless base loses to an available variant", () => {
    const out = selectCurrentVariants([mk("V-008", false), mk("V-008K", true)]);
    expect(out.find((p) => p.codart === "V-008K")!.is_current_variant).toBe(true);
  });

  it("falls back to lowest suffix when none available", () => {
    const out = selectCurrentVariants([mk("A9-465F", false), mk("A9-465A", false)]);
    expect(out.find((p) => p.codart === "A9-465A")!.is_current_variant).toBe(true);
    expect(out.filter((p) => p.is_current_variant)).toHaveLength(1);
  });

  it("single products are trivially current", () => {
    const out = selectCurrentVariants([mk("V-001", true)]);
    expect(out[0].is_current_variant).toBe(true);
  });

  it("exactly one current per group, always", () => {
    const out = selectCurrentVariants([
      mk("A6-092A", true),
      mk("A6-092B", true),
      mk("A6-092T", false),
      mk("V-001", true),
    ]);
    expect(out).toHaveLength(4);
    const groups = new Map<string, number>();
    for (const p of out) {
      if (p.is_current_variant) groups.set(p.base_sku, (groups.get(p.base_sku) ?? 0) + 1);
    }
    expect([...groups.keys()].sort()).toEqual(["A6-092", "V-001"]);
    expect([...groups.values()].every((n) => n === 1)).toBe(true);
    expect(out.find((p) => p.codart === "A6-092A")!.is_current_variant).toBe(true);
  });

  it("mutates the passed products in place and returns the same array", () => {
    const stale = mk("A9-465A", false);
    const winner = mk("A9-465B", true);
    const input = [stale, winner];
    const out = selectCurrentVariants(input);
    expect(out).toBe(input);
    expect(stale.is_current_variant).toBe(false);
    expect(winner.is_current_variant).toBe(true);
  });

  it("survives a duplicated codart with a single current", () => {
    const out = selectCurrentVariants([mk("A9-465A", true), mk("A9-465A", true)]);
    expect(out.filter((p) => p.is_current_variant)).toHaveLength(1);
    expect(out[0].is_current_variant).toBe(true);
  });

  it("order of the input does not change the winner", () => {
    const forward = selectCurrentVariants([mk("A9-465A", true), mk("A9-465B", true), mk("A9-465C", true)]);
    const reverse = selectCurrentVariants([mk("A9-465C", true), mk("A9-465B", true), mk("A9-465A", true)]);
    expect(forward.find((p) => p.is_current_variant)!.codart).toBe("A9-465A");
    expect(reverse.find((p) => p.is_current_variant)!.codart).toBe("A9-465A");
  });
});
