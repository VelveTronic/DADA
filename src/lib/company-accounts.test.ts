import { describe, expect, it } from "vitest";
import { groupAccountsByCompany, type CompanyGroup } from "./company-accounts";

/**
 * The client list on `/staff/usuarios` is built entirely from this function, and
 * none of what it decides is visible in the markup that renders the result: a
 * lost account, two restaurants merged into one block, or a tail group sorted
 * into the middle of the list would all draw a perfectly plausible page.
 */

type Company = { name: string; codcli: number | null };
type Account = {
  id: string;
  company_id: string;
  companies: Company | null;
};

/** One account, spelled as the page's read hands it over. */
const account = (
  id: string,
  companyId: string,
  name: string | null,
  codcli: number | null = null,
): Account => ({
  id,
  company_id: companyId,
  companies: name === null ? null : { name, codcli },
});

/** Code-point order — deterministic, and not the page's collator. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The readable summary each case is asserted against. */
const shape = (groups: CompanyGroup<Account>[]) =>
  groups.map((group) => [
    group.company?.name ?? null,
    group.accounts.map((row) => row.id).join(","),
  ]);

describe("groupAccountsByCompany", () => {
  it("returns nothing for no accounts", () => {
    expect(groupAccountsByCompany<Account>([], byCodePoint)).toEqual([]);
  });

  it("puts every account of one restaurant in one group, in input order", () => {
    const rows = [
      account("u1", "c1", "Alba"),
      account("u2", "c1", "Alba"),
      account("u3", "c1", "Alba"),
    ];
    expect(shape(groupAccountsByCompany(rows, byCodePoint))).toEqual([
      ["Alba", "u1,u2,u3"],
    ]);
  });

  it("groups rows of the same restaurant that are NOT adjacent in the input", () => {
    // The read is ordered by the ACCOUNT's `created_at`, so two logins for one
    // restaurant are routinely separated by a third restaurant's.
    const rows = [
      account("u1", "c1", "Alba"),
      account("u2", "c2", "Bao"),
      account("u3", "c1", "Alba"),
    ];
    expect(shape(groupAccountsByCompany(rows, byCodePoint))).toEqual([
      ["Alba", "u1,u3"],
      ["Bao", "u2"],
    ]);
  });

  it("groups by company_id, not by name — two restaurants may share one", () => {
    const rows = [
      account("u1", "c1", "海鲜楼", 3001),
      account("u2", "c2", "海鲜楼", 3002),
    ];
    const groups = groupAccountsByCompany(rows, byCodePoint);
    expect(groups.map((group) => group.id)).toEqual(["c1", "c2"]);
    expect(groups.map((group) => group.company?.codcli)).toEqual([3001, 3002]);
  });

  it("orders restaurants by the caller's comparator, not by first appearance", () => {
    const rows = [
      account("u1", "c3", "Ceylan"),
      account("u2", "c1", "Alba"),
      account("u3", "c2", "Bao"),
    ];
    expect(shape(groupAccountsByCompany(rows, byCodePoint))).toEqual([
      ["Alba", "u2"],
      ["Bao", "u3"],
      ["Ceylan", "u1"],
    ]);
  });

  it("keeps first-appearance order between restaurants the comparator ties", () => {
    const rows = [
      account("u1", "c2", "Alba"),
      account("u2", "c1", "Alba"),
    ];
    expect(groupAccountsByCompany(rows, byCodePoint).map((g) => g.id)).toEqual([
      "c2",
      "c1",
    ]);
  });

  it("collects company-less accounts into ONE tail group, last", () => {
    const rows = [
      account("u1", "c9", null),
      account("u2", "c1", "Zunzun"),
      account("u3", "c8", null),
    ];
    const groups = groupAccountsByCompany(rows, byCodePoint);
    expect(shape(groups)).toEqual([
      ["Zunzun", "u2"],
      [null, "u1,u3"],
    ]);
    expect(groups[1]).toMatchObject({ id: null, company: null });
  });

  it("keeps the tail last however the comparator would have sorted it", () => {
    // Reversed order: the tail must not follow the comparator at all — it has no
    // name to compare.
    const rows = [account("u1", "c9", null), account("u2", "c1", "Alba")];
    const groups = groupAccountsByCompany(rows, (a, b) => -byCodePoint(a, b));
    expect(shape(groups)).toEqual([
      ["Alba", "u2"],
      [null, "u1"],
    ]);
  });

  it("draws no tail group when every account has a restaurant", () => {
    const rows = [account("u1", "c1", "Alba")];
    expect(groupAccountsByCompany(rows, byCodePoint)).toHaveLength(1);
  });

  it("draws ONLY the tail group when no account has one", () => {
    const rows = [account("u1", "c1", null), account("u2", "c2", null)];
    expect(shape(groupAccountsByCompany(rows, byCodePoint))).toEqual([
      [null, "u1,u2"],
    ]);
  });
});
