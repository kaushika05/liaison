import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    // Runs before any test module is imported, so a local .env cannot put the suite into a
    // provider-calling mode. See tests/setup-hermetic-env.ts.
    setupFiles: ["tests/setup-hermetic-env.ts"],
    coverage: { provider: "v8", reporter: ["text-summary", "lcov"], include: ["src/**/*.{ts,tsx}"], exclude: ["src/client/vite-env.d.ts"] },
  },
});
