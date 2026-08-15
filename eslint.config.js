import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-server", "node_modules", "playwright-report", "test-results", "data", "coverage", "study-packet"] },
  js.configs.recommended,
  // Type-aware linting. This project is heavily asynchronous and deliberately uses fire-and-forget
  // calls in a few places, so `no-floating-promises` proving the rest are awaited is worth the
  // extra type-check pass in CI.
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      // Named explicitly rather than via projectService, because this repo uses three custom-named
      // tsconfigs (client, server, tools) that auto-discovery does not pick up.
      parserOptions: { project: ["./tsconfig.json", "./tsconfig.server.json", "./tsconfig.tools.json"], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "error",
      // The two rules this project actually adopted type-aware linting for.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Error codes are compared and concatenated as strings throughout; the template-expression
      // rule fights that pattern without catching real defects here.
      "@typescript-eslint/restrict-template-expressions": "off",
      // Adapter methods are `async` to satisfy a `Promise`-returning interface even when a given
      // implementation has nothing to await. That is the point of the abstraction, not a mistake.
      "@typescript-eslint/require-await": "off",
      // `String(x)` over values decoded from stored JSON is deliberate: the result is immediately
      // length-bounded and then validated by a Zod schema, so a non-string input fails loudly at
      // the parse rather than silently stringifying.
      "@typescript-eslint/no-base-to-string": "off",
      // `unknown | null` reads as "absent or unvalidated" in the record types and is kept for
      // documentation value.
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },
  {
    // Fastify's `inject().json()` is typed `any` by design. Tests assert on those payloads
    // constantly, and the schema parses inside the assertions are the real type check.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
