import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const kanbanProxyTarget =
    env.KANBAN_PROXY_TARGET?.trim() || "http://127.0.0.1:17888";

  return {
    plugins: [svelte()],
    server: {
      port: 4174,
      proxy: {
        "/kanban": {
          target: kanbanProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
