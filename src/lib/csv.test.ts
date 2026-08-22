import { describe, expect, it } from "vitest";
import { csvCell, csvDocument } from "./csv";

describe("csv export", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });

  it("neutralizes every supported spreadsheet formula prefix", () => {
    for (const [value, expected] of [
      ["=1+1", "'=1+1"],
      ["+SUM(A:A)", "'+SUM(A:A)"],
      ["-2", "'-2"],
      ["@cmd", "'@cmd"],
      ["\tformula", "'\tformula"],
      ["\rformula", "\"'\rformula\""],
      ["\nformula", "\"'\nformula\""],
      ["＝1+1", "'＝1+1"],
      ["＋SUM(A:A)", "'＋SUM(A:A)"],
      ["－2", "'－2"],
      ["＠cmd", "'＠cmd"],
    ]) {
      expect(csvCell(value)).toBe(expected);
    }
    expect(csvCell("SKU-2")).toBe("SKU-2");
  });

  it("adds an Excel-friendly UTF-8 BOM and CRLF rows", () => {
    expect(csvDocument([["中文", null], [1, true]])).toBe(
      "\uFEFF中文,\r\n1,true\r\n",
    );
  });
});
