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
  ]),
]);

export default eslintConfig;
