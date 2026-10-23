/**
 * poteto 模式的默认值。读 pi 已有的 settings 两层（global 与 project），
 * 键名 `potetoMode`，写法跟 plan-mode 的 `planMode` 一致。
 *
 * 会话里的显式开关（`poteto.mode.v1` entry）永远压过这里；这里只回答
 * 「一条记录都没有时算开还是算关」。
 */

import { loadSettings } from "../shared/settings.js";

export type PotetoModeConfig = {
  /** 没有任何会话记录时是否默认注入。 */
  defaultEnabled: boolean;
};

export const DEFAULT_POTETO_CONFIG: PotetoModeConfig = {
  defaultEnabled: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 纯函数：已合并的 settings 快照进，配置出。 */
export const potetoConfigFrom = (merged: unknown): PotetoModeConfig => {
  if (!isRecord(merged) || !isRecord(merged.potetoMode)) {
    return { ...DEFAULT_POTETO_CONFIG };
  }
  const defaultEnabled = merged.potetoMode.defaultEnabled;
  return {
    defaultEnabled:
      typeof defaultEnabled === "boolean"
        ? defaultEnabled
        : DEFAULT_POTETO_CONFIG.defaultEnabled,
  };
};

export const loadPotetoModeConfig = (cwd: string): PotetoModeConfig =>
  potetoConfigFrom(loadSettings(cwd).merged);
