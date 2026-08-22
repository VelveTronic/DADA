import { describe, expect, it } from "vitest";
import { ACCOUNT_PATHS, activeTab, type TabKey } from "./nav-tabs";

/**
 * The table IS the contract. Nothing else in the app proves which tab lights on
 * which route: the bar itself only ever sees the pathname a browser is actually
 * on, and a fixture route cannot sit on `/catalogo`.
 */
describe("activeTab", () => {
  const cases: Array<[string, TabKey | null]> = [
    ["/catalogo", "catalog"],
    // Search is entered from 商店/Tienda and therefore keeps that tab lit.
    ["/buscar", "catalog"],
    ["/categorias", "categories"],
    ["/carrito", "cart"],
    ["/cuenta", "account"],
    ["/pedidos", "account"],
    ["/direcciones", "account"],
    ["/perfil", "account"],
    // Sub-paths belong to their tab: an order's own page is still 我的.
    ["/pedidos/1234", "account"],
    ["/catalogo/", "catalog"],
    ["/categorias/aceites", "categories"],
    // …and a path that merely STARTS with one of the words is not it.
    ["/catalogofalso", null],
    ["/buscar-algo", null],
    ["/categoriasfalso", null],
    // Outside the customer shell, or nowhere at all.
    ["/", null],
    ["", null],
    ["/login", null],
    ["/staff", null],
    ["/staff/pedidos", null],
    ["/nope", null],
  ];

  for (const [pathname, expected] of cases) {
    it(`${pathname || "(empty)"} → ${expected ?? "null"}`, () => {
      expect(activeTab(pathname)).toBe(expected);
    });
  }

  it("lights 我的 for every page behind the account menu", () => {
    for (const path of ACCOUNT_PATHS) {
      expect(activeTab(path), path).toBe("account");
    }
  });
});
