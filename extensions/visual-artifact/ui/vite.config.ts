// Vite config for visual-artifact UI.
// Avoid defineConfig() due to duplicate Vite installations in the monorepo
// (pi-kit root vs pi-webterm/ui) causing Plugin type incompatibility.

export default async (): Promise<Record<string, unknown>> => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import skips ESM-only require trap
  const svelteMod: any = await import("@sveltejs/vite-plugin-svelte");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import skips ESM-only require trap
  const tailwindMod: any = await import("@tailwindcss/vite");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  return {
    plugins: [tailwindMod.default(), svelteMod.svelte()],
    resolve: {
      alias: {
        $lib: path.resolve(__dirname, "src/lib"),
        $components: path.resolve(__dirname, "src/components"),
      },
    },
    build: {
      outDir: "../ui-dist",
      emptyOutDir: true,
      modulePreload: false,
      chunkSizeWarningLimit: 4000,
      rolldownOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  };
};
