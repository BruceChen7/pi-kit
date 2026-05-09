import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "extensions/kanban-worktree/ui",
  plugins: [svelte()],
  build: {
    outDir: "../ui-dist",
    emptyOutDir: true,
  },
});
