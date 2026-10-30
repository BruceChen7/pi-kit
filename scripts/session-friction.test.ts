import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCRIPT = path.join(REPO_ROOT, "scripts/session-friction.mjs");

const line = (payload: object) => JSON.stringify(payload);

const errorResult = (text: string) =>
  line({
    type: "message",
    timestamp: "2026-10-30T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName: "edit",
      content: [{ type: "text", text }],
      isError: true,
    },
  });

const okResult = (text: string) =>
  line({
    type: "message",
    timestamp: "2026-10-30T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName: "edit",
      content: [{ type: "text", text }],
      isError: false,
    },
  });

const writeSession = (repo: string, lines: string[]): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-friction-"));
  const dir = path.join(root, `--Users-me-work-${repo}--`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "2026-10-30T00-00-00-000Z_x.jsonl"),
    `${lines.join("\n")}\n`,
  );
  return root;
};

type FrictionSignature = {
  signature: string;
  marked: number;
  mentioned: number;
};

type FrictionReport = {
  sessions: number;
  errorResults: number;
  signatures: FrictionSignature[];
  byRepo: Record<string, number>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFrictionReport = (value: unknown): value is FrictionReport => {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.signatures) && typeof value.errorResults === "number"
  );
};

const run = (sessions: string, extra: string[] = []): FrictionReport => {
  const raw = execFileSync(
    process.execPath,
    [SCRIPT, "--sessions", sessions, "--json", ...extra],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const value: unknown = JSON.parse(raw);
  if (!isFrictionReport(value)) {
    throw new Error("session-friction.mjs returned an unexpected shape");
  }
  return value;
};

const countOf = (
  report: FrictionReport,
  signature: string,
): FrictionSignature => {
  const row = report.signatures.find((entry) => entry.signature === signature);
  if (row === undefined) throw new Error(`missing signature ${signature}`);
  return row;
};

describe("session-friction", () => {
  it("counts a blocked edit as a marked error", () => {
    const root = writeSession("pi-kit", [
      errorResult(
        "plan-mode blocked edit: read the file first before modifying it: a.ts",
      ),
      okResult("Applied 1 edit(s) successfully"),
    ]);

    const report = run(root);

    expect(report.errorResults).toBe(1);
    expect(countOf(report, "plan-mode blocked").marked).toBe(1);
    expect(countOf(report, "read the file first").marked).toBe(1);
  });

  it("separates a failure the model was never told about", () => {
    const root = writeSession("pi-kit", [
      // 实录形态：错误以成功返回，isError 缺席（F4）。
      line({
        type: "message",
        timestamp: "2026-10-30T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolName: "act_mode_todo",
          content: [
            {
              type: "text",
              text: "Error: pass either id or updates for update, not both.",
            },
          ],
        },
      }),
    ]);

    const report = run(root);

    expect(report.errorResults).toBe(0);
    expect(countOf(report, "pass either id or updates")).toEqual({
      signature: "pass either id or updates",
      marked: 0,
      mentioned: 1,
    });
  });

  it("groups marked errors by repo", () => {
    const root = writeSession("pi-kit", [
      errorResult("Could not find the exact text in a.ts."),
      errorResult("Could not find the exact text in b.ts."),
    ]);

    const report = run(root, ["--by-repo"]);

    expect(report.byRepo).toEqual({ "pi-kit": 2 });
  });

  it("ignores session files older than the window", () => {
    const root = writeSession("pi-kit", [
      errorResult("plan-mode blocked bash"),
    ]);
    const file = path.join(
      root,
      "--Users-me-work-pi-kit--",
      "2026-10-30T00-00-00-000Z_x.jsonl",
    );
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(file, old / 1000, old / 1000);

    const report = run(root, ["--days", "7"]);

    expect(report.sessions).toBe(0);
    expect(report.errorResults).toBe(0);
  });
});
