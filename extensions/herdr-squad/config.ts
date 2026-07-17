import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

export interface HerdrSquadConfig {
  defaultModel?: string | null;
}

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

let configLog: ReturnType<typeof createLogger> | null = null;

function getConfigLog(): ReturnType<typeof createLogger> {
  if (!configLog) configLog = createLogger("herdr-squad", { stderr: null });
  return configLog;
}

export function resolveConfiguredModel(
  cwd: string,
  projectTrusted: boolean,
): ResolvedModelConfig {
  const { global, project } = loadSettings(cwd);

  // 1. Project config (trusted only)
  if (projectTrusted) {
    const projectSection = isRecord(project.herdrSquad)
      ? (project.herdrSquad as Record<string, unknown>)
      : {};
    const projectModel = sanitizeModel(projectSection.defaultModel);
    if (projectModel === null) {
      getConfigLog().debug(
        "Model: project config set to null, fall through to pi-default",
      );
      return { source: "pi-default" };
    }
    if (projectModel !== undefined) {
      getConfigLog().info("Model resolved from project config", {
        model: projectModel,
        source: "project",
      });
      return { model: projectModel, source: "project" };
    }
    getConfigLog().debug("Model: no project config found");
  } else {
    getConfigLog().debug("Model: project not trusted, skipping project config");
  }

  // 2. Global config
  const globalSection = isRecord(global.herdrSquad)
    ? (global.herdrSquad as Record<string, unknown>)
    : {};
  const globalModel = sanitizeModel(globalSection.defaultModel);
  if (globalModel !== undefined) {
    getConfigLog().info("Model resolved from global config", {
      model: globalModel,
      source: "global",
    });
    return { model: globalModel, source: "global" };
  }
  getConfigLog().debug("Model: no global config found, using pi-default");

  // 3. Pi default
  getConfigLog().info("Model resolved as pi-default");
  return { source: "pi-default" };
}

export function validateExplicitModel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) {
    throw new Error("Explicit model value is empty or exceeds 200 characters");
  }
  return trimmed;
}
