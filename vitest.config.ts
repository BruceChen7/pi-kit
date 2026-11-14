import { defineConfig } from "vitest/config";

/**
 * Minimal plugin to handle .svelte module imports during tests.
 * Since no test actually renders Svelte components, we just return a stub
 * to avoid errors from the Svelte Vite plugin checking for config.
 */
function svelteStubPlugin() {
  return {
    name: "svelte-stub",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (id.endsWith(".svelte")) {
        return id;
      }
      return undefined;
    },
    load(id: string) {
      if (id.endsWith(".svelte")) {
        return "export default {};";
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [svelteStubPlugin()],
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/.pi/**", "**/dist/**"],
    // 宿主档案不能被跑测试的 shell 带偏（`PI_KIT_UI_HOST`，见该文件的注释）。
    setupFiles: ["./vitest.setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
