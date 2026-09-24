import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ["src/__tests__/globalSetup.ts"],
    env: {
      ANTHROPIC_API_KEY: "sk-ant-test-placeholder-for-unit-tests",
    },
  },
});
