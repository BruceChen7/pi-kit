import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/.pi/**", "**/dist/**"],
    clearMocks: true,
    restoreMocks: true,
  },
});
