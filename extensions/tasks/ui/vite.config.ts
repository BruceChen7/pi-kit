// Vite config for the tasks UI.
// Avoid defineConfig() due to duplicate Vite installations in the monorepo
// (pi-kit root vs pi-webterm/ui) causing Plugin type incompatibility.

export default async (): Promise<Record<string, unknown>> => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import skips ESM-only require trap
  const svelteMod: any = await import("@sveltejs/vite-plugin-svelte");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import skips ESM-only require trap
  const tailwindMod: any = await import("@tailwindcss/vite");
  return {
    plugins: [tailwindMod.default(), svelteMod.svelte()],
    build: {
      outDir: "../ui-dist",
      emptyOutDir: true,
      modulePreload: false,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  };
};
