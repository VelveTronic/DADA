import { describe, expect, it } from "vitest";
import es from "../../messages/es.json";
import zh from "../../messages/zh.json";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translations", () => {
  it("keeps Spanish and Chinese message keys aligned", () => {
    expect(leafKeys(es).sort()).toEqual(leafKeys(zh).sort());
  });
});
