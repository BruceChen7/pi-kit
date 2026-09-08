/**
 * query-notes-log — Imperative Shell：文件 IO
 *
 * 全局日志目录解析、按月 JSONL 读写、最近 N 条加载、重复计数更新。
 * 只做 IO，不做判定逻辑（判定在 core.ts）。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { type QueryLogEntry, withRepeat } from "./core.ts";

const log = createLogger("query-notes-log", { stderr: null });

/** 全局日志目录：<homedir>/.pi/agent/query-notes-log（CONFIG_DIR_NAME 兼容 rebrand） */
export function resolveLogDir(): string {
  return path.join(homedir(), CONFIG_DIR_NAME, "agent", "query-notes-log");
}

/** 按月分文件：YYYY-MM.jsonl（本地时区） */
export function monthFile(dir: string, d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return path.join(dir, `${y}-${m}.jsonl`);
}

/** 解析单行 JSONL；非法/结构不符返回 null（调用方决定跳过策略） */
export function parseLine(line: string): QueryLogEntry | null {
  try {
    const entry = JSON.parse(line) as QueryLogEntry;
    if (
      typeof entry?.id === "string" &&
      typeof entry?.ts === "number" &&
      typeof entry?.q === "string" &&
      typeof entry?.repeats === "number"
    ) {
      return entry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 加载最近 n 条：从当月文件起向前扫各月（最多 24 个月），
 * 跳过坏行并 warn，按 ts 倒序取最近 n 条；目录不存在返回 []。
 */
export async function loadRecentEntries(
  dir: string,
  n: number,
): Promise<QueryLogEntry[]> {
  const entries: QueryLogEntry[] = [];
  const now = new Date();
  for (let i = 0; i < 24 && entries.length < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const file = monthFile(dir, d);
    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue; // 月份文件缺失/不可读，跳到更早月份
    }
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = parseLine(line);
      if (entry === null) {
        log.warn("skipping bad line", { file });
        continue;
      }
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => b.ts - a.ts).slice(0, n);
}

/** 追加新条目：目录不存在则自动创建（mkdir -p），append 一行 */
export async function appendEntry(
  dir: string,
  entry: QueryLogEntry,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = monthFile(dir, new Date(entry.ts));
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * 语义重复计数 +1：按条目自身 ts 定位其所属月份文件，整月重写（个人规模，月度文件小）。
 * 文件缺失或条目不在其中则忽略（防御，不抛错）。
 */
export async function incrementRepeat(
  dir: string,
  entry: QueryLogEntry,
): Promise<void> {
  const file = monthFile(dir, new Date(entry.ts));
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return; // 目标月份文件尚不存在
  }
  const lines = content.split("\n");
  let changed = false;
  const updated = lines.map((line) => {
    if (line.trim().length === 0) return line;
    const parsed = parseLine(line);
    if (parsed === null || parsed.id !== entry.id) return line;
    changed = true;
    return JSON.stringify(withRepeat(parsed));
  });
  if (changed) {
    await fs.writeFile(file, updated.join("\n"), "utf-8");
  }
}
