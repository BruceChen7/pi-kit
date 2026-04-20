import fs from "node:fs";
import path from "node:path";

import type { ExecutionAuditRecord } from "./types.js";

export function appendExecutionAuditLog(
  logPath: string,
  record: ExecutionAuditRecord,
): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
}
