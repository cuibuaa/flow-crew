export default {
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/ui/**/*.test.tsx"],
    setupFiles: ["ui/tests/ui/test-setup.ts"],
    isolate: true,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    pool: "vmThreads",
    maxWorkers: 1,
    fileParallelism: false,
  },
};
