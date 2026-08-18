import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // `pnpm bridge:build` writes a 3 MB esbuild bundle to bridge/dist. It is
    // generated output — the source it is built from (src/bridge) is linted —
    // and Task 4 hands that file to the owner, so it exists on any machine that
    // has run a build. Linting it reports over a hundred errors from bundled
    // dependencies and would make the gate depend on whether a build had run.
    "bridge/**",
    // The design mockups are a bundle from Claude Design, checked in as the
    // reference the redesign is built against: an inline-styled HTML page and
    // the `support.js` runtime that renders it, whose own first line says
    // GENERATED, do not edit. Same rule as `bridge/**` — it is somebody else's
    // build output, it ships nothing, and linting it turns the repo's gate red
    // over `ReactDOM.render` in a vendored file we cannot fix.
    "docs/design/**",
  ]),
]);

export default eslintConfig;
