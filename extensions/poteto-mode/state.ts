/**
 * 模式状态：命令解析、快照往返、从 session 分支恢复。
 *
 * 全部是值到值的函数；写 entry 与读 branch 在 index.ts。
 * 形状与 plan-mode 的 `state.ts` 同构，切分支时恢复语义一致。
 */

import type { PotetoModeState } from "./guidance.js";

export const POTETO_MODE_ENTRY = "poteto.mode.v1";

export type PotetoModeSnapshot = {
  version: 1;
  enabled: boolean;
};

export type PotetoCommandKind = "on" | "off" | "status" | "preview";

export type PotetoCommand =
  | { kind: PotetoCommandKind }
  | { kind: "invalid"; value: string };

const COMMANDS: readonly PotetoCommandKind[] = [
  "on",
  "off",
  "status",
  "preview",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isCommandKind = (value: string): value is PotetoCommandKind =>
  (COMMANDS as readonly string[]).includes(value);

/** 空参数等同 `status`：`/poteto-mode` 单独敲下去应该报告现状，不是报错。 */
export const parsePotetoCommand = (raw: string): PotetoCommand => {
  const value = raw.trim().toLowerCase();
  if (value === "") {
    return { kind: "status" };
  }
  return isCommandKind(value)
    ? { kind: value }
    : { kind: "invalid", value: raw.trim() };
};

export const potetoSnapshot = (enabled: boolean): PotetoModeSnapshot => ({
  version: 1,
  enabled,
});

export const isPotetoSnapshot = (value: unknown): value is PotetoModeSnapshot =>
  isRecord(value) && value.version === 1 && typeof value.enabled === "boolean";

const snapshotFromEntry = (entry: unknown): PotetoModeSnapshot | null => {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== POTETO_MODE_ENTRY
  ) {
    return null;
  }
  return isPotetoSnapshot(entry.data) ? entry.data : null;
};

/** 取最后一条有效快照；畸形 entry 跳过，不抛。 */
export const latestPotetoState = (
  entries: readonly unknown[],
): PotetoModeState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotFromEntry(entries[index]);
    if (snapshot) {
      return { enabled: snapshot.enabled, explicit: true };
    }
  }
  return { enabled: false, explicit: false };
};

/**
 * 会话记录与默认值的优先级：显式记录压过默认值；没有记录时用默认值。
 * 默认值算「已设置」，否则 `explicit: false` 会把注入整个关掉。
 */
export const resolvePotetoState = (
  fromBranch: PotetoModeState,
  defaultEnabled: boolean,
): PotetoModeState =>
  fromBranch.explicit
    ? fromBranch
    : { enabled: defaultEnabled, explicit: defaultEnabled };
