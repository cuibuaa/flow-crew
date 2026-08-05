import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const UI_NODE_MODULES = resolve(import.meta.dirname, "node_modules");

// Vitest workers resolve root-relative module ids against process.cwd(). Keep
// both supported invocation directories bound to the same public test root.
process.chdir(PROJECT_ROOT);

export default defineConfig({
  root: PROJECT_ROOT,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(UI_NODE_MODULES, "react/index.js") },
      { find: /^react\/jsx-runtime$/, replacement: resolve(UI_NODE_MODULES, "react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(UI_NODE_MODULES, "react/jsx-dev-runtime.js") },
      { find: /^react-dom$/, replacement: resolve(UI_NODE_MODULES, "react-dom/index.js") },
      { find: /^react-dom\/client$/, replacement: resolve(UI_NODE_MODULES, "react-dom/client.js") },
      { find: /^react-dom\/server$/, replacement: resolve(UI_NODE_MODULES, "react-dom/server.node.js") },
      { find: /^react-dom\/test-utils$/, replacement: resolve(UI_NODE_MODULES, "react-dom/test-utils.js") },
      { find: /^react-router-dom$/, replacement: resolve(UI_NODE_MODULES, "react-router-dom/dist/index.js") },
      {
        find: /^@testing-library\/react$/,
        replacement: resolve(UI_NODE_MODULES, "@testing-library/react/dist/@testing-library/react.esm.js"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["spec/ui/**/*.test.tsx"],
    setupFiles: [resolve(UI_NODE_MODULES, "@testing-library/jest-dom/dist/vitest.mjs")],
    isolate: true,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    pool: "vmThreads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
