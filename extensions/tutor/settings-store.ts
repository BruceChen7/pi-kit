/**
 * settings-store — settings → vault 路径的唯一入口（Imperative Shell 的最小 IO 边界）。
 *
 * 原先 notes-store / concepts-store / topic-store 各抄一份「读设置 + 展开 `~`」，
 * 「同源」靠人工同步；现在只有这一份。坏配置回落默认值 + warning 的判定仍在
 * notes-core 的纯函数 `resolveTutorSettings`。
 *
 * 依赖方向：{ notes-store, concepts-store, topic-store, topic-status, index } → settings-store
 * → { shared/settings, notes-core }（无环）。
 */

import os from "node:os";
import { loadSettings } from "../shared/settings.ts";
import {
  expandHome,
  resolveTutorSettings,
  type TutorSettings,
} from "./notes-core.ts";

/** 读 `cwd` 的设置并把 `~` 展开（home 缺省取 `os.homedir()`）。 */
export const resolveSettings = (deps: {
  cwd: string;
  home?: string;
}): TutorSettings => {
  const settings = resolveTutorSettings(loadSettings(deps.cwd).merged);
  return {
    ...settings,
    vaultRoot: expandHome(settings.vaultRoot, deps.home ?? os.homedir()),
  };
};
