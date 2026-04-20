import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendExecutionAuditLog } from "./audit-log.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-audit-log-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendExecutionAuditLog", () => {
  it("appends JSONL records", () => {
    const dir = createTempDir();
    const logPath = path.join(dir, "execution.log.jsonl");

    appendExecutionAuditLog(logPath, {
      ts: "2026-04-20T00:00:00.000Z",
      requestId: "req-1",
      cardId: "feat-checkout-v2",
      worktreeKey: "main--feat-checkout-v2",
      action: "apply",
      executor: "orchestrator",
      status: "success",
      durationMs: 32,
      summary: "ok",
    });

    appendExecutionAuditLog(logPath, {
      ts: "2026-04-20T00:00:01.000Z",
      requestId: "req-2",
      cardId: "feat-pricing-v2",
      worktreeKey: "main--feat-pricing-v2",
      action: "reconcile",
      executor: "orchestrator",
      status: "failed",
      durationMs: 44,
      summary: "error",
    });

    const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as { requestId: string; action: string };
    const second = JSON.parse(lines[1]) as {
      requestId: string;
      action: string;
    };
    expect(first).toMatchObject({ requestId: "req-1", action: "apply" });
    expect(second).toMatchObject({ requestId: "req-2", action: "reconcile" });
  });
});
