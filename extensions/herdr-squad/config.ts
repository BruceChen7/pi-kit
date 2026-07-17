export interface ResolvedModelConfig {
  model?: string;
  source: "global" | "project" | "pi-default";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeModel = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.length <= 200) return trimmed;
  }
  return undefined;
};

export function resolveConfiguredModel(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown>,
  projectTrusted: boolean,
): ResolvedModelConfig {
  // 1. Project config (trusted only)
  if (projectTrusted) {
    const projectSection = isRecord(projectSettings.herdrSquad)
      ? (projectSettings.herdrSquad as Record<string, unknown>)
      : {};
    const projectModel = sanitizeModel(projectSection.defaultModel);
    if (projectModel === null) {
      return { source: "pi-default" };
    }
    if (projectModel !== undefined) {
      return { model: projectModel, source: "project" };
    }
  }

  // 2. Global config
  const globalSection = isRecord(globalSettings.herdrSquad)
    ? (globalSettings.herdrSquad as Record<string, unknown>)
    : {};
  const globalModel = sanitizeModel(globalSection.defaultModel);
  if (globalModel !== undefined) {
    return { model: globalModel, source: "global" };
  }

  // 3. Pi default
  return { source: "pi-default" };
}
