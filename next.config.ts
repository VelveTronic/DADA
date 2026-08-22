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
    serverActions: {
      /**
       * Catalogue images are uploaded THROUGH a Server Action, and the default
       * body limit is 1 MB
       * (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`).
       * `MAX_CATALOG_IMAGE_BYTES` is 5 MB and both locales print that number to
       * the staff member, so without this the promise was unkeepable: a 2 MB
       * photo — an ordinary phone snapshot — died in the framework before
       * `validateCatalogImage` ever saw it, with a body-size error instead of
       * the sized, translated message the form is built to show.
       *
       * 6 and not 5: the limit covers the whole multipart body, so it has to
       * hold the file PLUS its base64/multipart overhead and the other form
       * fields. One megabyte of headroom keeps the app's own 5 MB check the
       * one that rejects an oversized image, which is the check that can
       * explain itself.
       */
      bodySizeLimit: "6mb",
    },
  },
};

export default withNextIntl(nextConfig);
