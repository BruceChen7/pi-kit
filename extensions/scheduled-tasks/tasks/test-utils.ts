/**
 * test-utils.ts — 共享测试辅助工具
 *
 * 为 scheduled-tasks 测试提供通用的 tempDir / cleanupDir 等工具函数。
 * 消除跨测试文件的重复代码。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 创建临时目录，用于 FS 相关的测试隔离。
 *
 * @param prefix - 目录名前缀（会被追加到系统 tmpdir 下）。
 * @returns 临时目录的绝对路径。
 */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 递归删除临时目录及其所有内容。
 *
 * 不会抛出异常——静默忽略删除失败（如权限问题、不存在的路径）。
 *
 * @param dir - 要删除的目录路径。
 */
export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}
