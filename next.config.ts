import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  experimental: {
    /**
     * The root layout lives under the top-level dynamic segment `[locale]`, which
     * is one of the two cases the Next 16 docs name for this flag
     * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/not-found.md`):
     * with no static root layout there is nothing to compose a 404 document from,
     * so unmatched URLs would otherwise render without <html>/<body>.
     * `src/app/global-not-found.tsx` supplies the full document instead.
     */
    globalNotFound: true,
  },
};

export default withNextIntl(nextConfig);
