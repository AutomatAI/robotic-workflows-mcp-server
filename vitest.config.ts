import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["api/**/*.ts"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 35,
        statements: 32,
        functions: 28,
        branches: 17,
      },
    },
  },
});
