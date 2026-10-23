/**
 * 收据存储：`<git common dir>/pi-receipts.json`。
 *
 * 放 git 目录而不是工作区：不污染 diff，不会被 .gitignore 漏掉，
 * 一个仓库一份，跟分支无关（同一台机器上同一次运行对所有分支都算数）。
 */

import fs from "node:fs";
import path from "node:path";
import { getGitCommonDir } from "../shared/git.js";
import type { Receipt } from "./parse.js";

export const MAX_RECEIPTS = 50;

export const receiptsPath = (cwd: string): string | null => {
  const common = getGitCommonDir(cwd);
  return common ? path.join(common, "pi-receipts.json") : null;
};

export const readReceipts = (file: string): Receipt[] => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const list = (parsed as { receipts?: unknown } | null)?.receipts;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter(
      (item): item is Receipt =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as Receipt).command === "string" &&
        typeof (item as Receipt).passed === "number",
    );
  } catch {
    return [];
  }
};

/** 同一条命令只留最新一条，整体最多 50 条。 */
export const appendReceipt = (file: string, receipt: Receipt): Receipt[] => {
  const next = [
    ...readReceipts(file).filter((item) => item.command !== receipt.command),
    receipt,
  ].slice(-MAX_RECEIPTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ version: 1, receipts: next }, null, 2)}\n`,
  );
  return next;
};
