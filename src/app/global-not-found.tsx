import type { Metadata } from "next";
import Link from "next/link";
import { routing } from "@/i18n/routing";
import "./globals.css";

/**
 * The 404 for URLs that match no route at all. It bypasses the layout tree
 * entirely, so it must render its own complete document and import its own
 * styles (Next 16 file-conventions docs, `not-found.md` → `global-not-found.js`).
 *
 * Copy is hardcoded in both languages rather than translated: an unmatched URL
 * has no locale segment to resolve messages from. The document is `lang="zh"`
 * (the default locale), so each Spanish fragment carries its own `lang="es"` —
 * without it a screen reader voices the Spanish with Chinese pronunciation
 * rules.
 */
export const metadata: Metadata = {
  title: "404 · DADA",
};

export default function GlobalNotFound() {
  return (
    <html lang="zh">
      <body>
        <main>
          <h1>
            页面不存在 / <span lang="es">Página no encontrada</span>
          </h1>
          <p>
            <Link href={`/${routing.defaultLocale}`}>
              返回首页 / <span lang="es">Volver al inicio</span>
            </Link>
          </p>
        </main>
      </body>
    </html>
  );
}
