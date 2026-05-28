import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: new URL("./ui/node_modules/react/index.js", import.meta.url).pathname },
      { find: /^react\/jsx-runtime$/, replacement: new URL("./ui/node_modules/react/jsx-runtime.js", import.meta.url).pathname },
      { find: /^react\/jsx-dev-runtime$/, replacement: new URL("./ui/node_modules/react/jsx-dev-runtime.js", import.meta.url).pathname },
      { find: /^react-dom\/server$/, replacement: new URL("./ui/node_modules/react-dom/server.node.js", import.meta.url).pathname },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    isolate: true,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
