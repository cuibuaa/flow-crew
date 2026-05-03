export default {
  test: {
    include: ["tests/**/*.test.ts"],
    isolate: true,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
};
