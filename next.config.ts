import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  images: {
    /**
     * The product photos, and nothing else. `next/image` refuses any remote host
     * it was not told about (400 Bad Request), so the ~2,956 storage URLs on
     * `products.image_url` need this one pattern — narrowed to the PUBLIC object
     * path of the project named in CLAUDE.md, so a signed or admin storage URL
     * could never be optimised and served through the portal by mistake.
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "gudiykhngonoqsjoigza.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
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
