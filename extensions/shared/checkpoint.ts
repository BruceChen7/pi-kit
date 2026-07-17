/**
 * checkpoint.ts — 通用 JSON checkpoint 持久化工具
 *
 * 提供原子写入（write-temp-then-rename），防止崩溃导致 checkpoint 文件损坏。
 *
 * 纯 IO 层：负责读写磁盘，不包含业务逻辑。
 *
 * 使用方式：
 * ```ts
 * import { loadCheckpoint, saveCheckpoint } from "../../shared/checkpoint.ts";
 *
 * // 读取
 * const value = loadCheckpoint("/path/to/checkpoint.json", "lastHeadId");
 *
 * // 原子写入
 * saveCheckpoint("lastHeadId", "abc123", "/path/to/checkpoint.json");
 * ```
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * 从磁盘加载 checkpoint JSON 文件中的指定字段。
 *
 * @param checkpointPath - checkpoint JSON 文件的绝对路径。
 * @param fieldName - 要读取的字段名（如 "lastHeadId"）。
 * @returns 存储的字符串值，文件不存在或损坏时返回 null。
 */
export function loadCheckpoint(
  checkpointPath: string,
  fieldName: string,
): string | null {
  try {
    const raw = readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[fieldName] === "string"
      ? (parsed[fieldName] as string)
      : null;
  } catch {
    return null;
  }
}

/**
 * 将 checkpoint 字段值原子写入磁盘。
 *
 * 使用 write-temp-then-rename 策略：先将内容写入临时文件，然后 rename 到目标路径。
 * 这样即使写入过程中崩溃，原文件也不会损坏。
 *
 * @param fieldName - 要写入的字段名。
 * @param value - 要持久化的字符串值。
 * @param checkpointPath - checkpoint JSON 文件的绝对路径。
 */
export function saveCheckpoint(
  fieldName: string,
  value: string,
  checkpointPath: string,
): void {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${checkpointPath}.tmp.${Date.now()}`;
  try {
    writeFileSync(
      tmpPath,
      JSON.stringify({ [fieldName]: value }, null, 2),
      "utf-8",
    );
    renameSync(tmpPath, checkpointPath);
  } catch (err) {
    // 清理临时文件
    try {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath, { force: true });
      }
    } catch {
      // ignore cleanup failures
    }
    throw err;
  }
}
