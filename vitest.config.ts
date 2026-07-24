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
      // Ratchet-only floor: bump these up as real tests land (see
      // AGENTS.md / repository-harness.md). Never lower them, and never set
      // them above currently-measured coverage. Keep each floor just below
      // the measured value so ordinary instrumentation variance has margin.
      thresholds: {
        lines: 70,
        statements: 65,
        functions: 68,
        branches: 45,
      },
    },
  },
});
