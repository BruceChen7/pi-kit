// Vite config for visual-artifact UI.
// Avoid defineConfig() due to duplicate Vite installations in the monorepo
// (pi-kit root vs pi-webterm/ui) causing Plugin type incompatibility.

export default async (): Promise<Record<string, unknown>> => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import skips ESM-only require trap
  const mod: any = await import("@sveltejs/vite-plugin-svelte");

  return {
    plugins: [mod.svelte()],
    build: {
      outDir: "../ui-dist",
      emptyOutDir: true,
      modulePreload: false,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  };
};
