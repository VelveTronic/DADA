import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(),
}));

import { config } from "./proxy";

describe("proxy matcher", () => {
  it.each(["/", "/zh", "/es/catalogo", "/zh/product.with-dot"])(
    "matches application route %s",
    (url) => {
      expect(
        unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }),
      ).toBe(true);
    },
  );

  it.each([
    "/api/health",
    "/_next/static/app.js",
    "/favicon.ico",
    "/robots.txt",
  ])("skips infrastructure or asset route %s", (url) => {
    expect(
      unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }),
    ).toBe(false);
  });
});
