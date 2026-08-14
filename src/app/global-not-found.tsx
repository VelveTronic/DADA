import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

/**
 * The 404 for URLs that match no route at all. It bypasses the layout tree
 * entirely, so it must render its own complete document and import its own
 * styles (Next 16 file-conventions docs, `not-found.md` → `global-not-found.js`).
 *
 * Copy is hardcoded in both languages rather than translated: an unmatched URL
 * has no locale segment to resolve messages from.
 */
export const metadata: Metadata = {
  title: "404 · DADA",
};

export default function GlobalNotFound() {
  return (
    <html lang="zh">
      <body>
        <main>
          <h1>页面不存在 / Página no encontrada</h1>
          <p>
            <Link href="/zh">返回首页 / Volver al inicio</Link>
          </p>
        </main>
      </body>
    </html>
  );
}
