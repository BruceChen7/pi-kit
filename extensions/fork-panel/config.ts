export interface ResolvedModelConfig {
  model?: string;
  source: "global" | "project" | "pi-default";
}

export const FORK_PANEL_CONFIG_KEY = "forkPanel";

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

/**
 * 模型解析优先级：--model 显式参数（调用方处理）> 项目配置 forkPanel.defaultModel
 * > 全局配置 forkPanel.defaultModel > pi 默认。
 * 配置值为 null 时显式回退到 pi 默认（与 herdr-squad 一致）。
 */
export function resolveConfiguredModel(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown>,
  projectTrusted: boolean,
): ResolvedModelConfig {
  if (projectTrusted) {
    const projectSection = isRecord(projectSettings[FORK_PANEL_CONFIG_KEY])
      ? (projectSettings[FORK_PANEL_CONFIG_KEY] as Record<string, unknown>)
      : {};
    const projectModel = sanitizeModel(projectSection.defaultModel);
    if (projectModel === null) {
      return { source: "pi-default" };
    }
    if (projectModel !== undefined) {
      return { model: projectModel, source: "project" };
    }
  }

  const globalSection = isRecord(globalSettings[FORK_PANEL_CONFIG_KEY])
    ? (globalSettings[FORK_PANEL_CONFIG_KEY] as Record<string, unknown>)
    : {};
  const globalModel = sanitizeModel(globalSection.defaultModel);
  if (globalModel !== undefined) {
    return { model: globalModel, source: "global" };
  }

  return { source: "pi-default" };
}
