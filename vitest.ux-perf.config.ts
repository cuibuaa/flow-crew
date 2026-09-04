import baseConfig from "./vitest.config.ts";
import { defineConfig } from "vitest/config";

// This focused command is an additional verification surface. The replay
// specs remain part of the canonical full suite configured in vitest.config.ts.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      "spec/ux-perf-*.replay.ts",
      "spec/ux-perf-*.replay.tsx",
    ],
  },
});
