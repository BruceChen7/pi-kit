// Wrapper config that re-exports ui/vite.config with a root override.
// Mirrors extensions/visual-artifact/vite.config.mts.
// Build: npm run tasks:ui:build (vite build --config extensions/tasks/vite.config.mts)

import uiConfig from "./ui/vite.config";

export default async (): Promise<Record<string, unknown>> => {
  const resolved = await (typeof uiConfig === "function"
    ? uiConfig()
    : uiConfig);

  return {
    ...resolved,
    root: "extensions/tasks/ui",
  };
};
