// Wrapper config that re-exports ui/vite.config with a root override.
// Avoid defineConfig() — see ui/vite.config.ts for rationale.

import uiConfig from "./ui/vite.config";

export default async (): Promise<Record<string, unknown>> => {
  const resolved = await (typeof uiConfig === "function"
    ? uiConfig()
    : uiConfig);

  return {
    ...resolved,
    root: "extensions/visual-artifact/ui",
  };
};
