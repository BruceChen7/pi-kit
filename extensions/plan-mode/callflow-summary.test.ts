import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CalldiffResult } from "../shared/calldiff-json.ts";
import { runCalldiffJson } from "../shared/calldiff-runner.ts";
import {
  captureGitHead,
  formatCallflowSummary,
  maybeSendCallflowSummary,
} from "./callflow-summary.ts";

vi.mock("../shared/calldiff-runner.ts", () => ({
  runCalldiffJson: vi.fn(),
}));

const makeNode = (
  key: string,
  label: string,
  status: "same" | "added" | "removed" = "same",
  children: ReturnType<typeof makeNode>[] = [],
) => ({ key, label, status, children });

const diffResult: CalldiffResult = {
  mode: "diff",
  from: "abc123",
  to: "WORKTREE",
  trees: [
    {
      entry: "PiService.createAgentSession",
      ascii:
        "  PiService.createAgentSession(options)\n+ ├─ ModelRegistry.create()\n- ├─ AuthStorage.create()",
      tree: makeNode("root", "PiService.createAgentSession", "same", [
        makeNode("a", "AuthStorage.create()", "removed"),
        makeNode("b", "ModelRegistry.create()", "added"),
      ]),
    },
  ],
  ascii:
    "  PiService.createAgentSession(options)\n+ ├─ ModelRegistry.create()\n- ├─ AuthStorage.create()",
};

describe("formatCallflowSummary", () => {
  it("returns empty for non-diff modes", () => {
    const tree: CalldiffResult = {
      mode: "tree",
      ref: "HEAD",
      trees: [{ entry: "boot", ascii: "x", tree: makeNode("b", "boot()") }],
      ascii: "x",
    };
    expect(formatCallflowSummary(tree)).toBe("");
  });

  it("reports when nothing changed", () => {
    const summary = formatCallflowSummary({ ...diffResult, trees: [] });
    expect(summary).toContain("未检测到调用流变化");
  });

  it("lists per-entry +/- counts and the ascii block", () => {
    const summary = formatCallflowSummary(diffResult);
    expect(summary).toContain("调用流变化摘要");
    expect(summary).toContain("calldiff diff `abc123` → `WORKTREE`");
    expect(summary).toContain("PiService.createAgentSession: +1 / -1");
    expect(summary).toContain("```text");
    expect(summary).toContain("+ ├─ ModelRegistry.create()");
    expect(summary).toContain("create_calldiff_artifact");
  });

  it("caps entries and ascii lines", () => {
    const many: CalldiffResult = {
      ...diffResult,
      trees: Array.from({ length: 12 }, (_, i) => ({
        entry: `entry${i}`,
        ascii: Array.from({ length: 100 }, (_, j) => `line ${j}`).join("\n"),
        tree: makeNode(`e${i}`, `entry${i}()`),
      })),
      ascii: Array.from({ length: 100 }, (_, j) => `line ${j}`).join("\n"),
    };
    const summary = formatCallflowSummary(many, {
      maxEntries: 3,
      maxAsciiLines: 10,
    });
    expect(summary).toContain("共 12 个入口");
    expect(summary).toContain("90 more lines omitted");
    expect((summary.match(/^- entry\d/gm) ?? []).length).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Shell wiring: maybeSendCallflowSummary (runner mocked at the seam) */
/* ------------------------------------------------------------------ */

const diffStdout = JSON.stringify({
  mode: "diff",
  from: "abc123",
  to: "working tree",
  trees: [
    {
      entry: "PiService.createAgentSession",
      ascii: "+ ModelRegistry.create()",
      tree: {
        key: "root",
        label: "PiService.createAgentSession()",
        status: "same",
        children: [
          {
            key: "a",
            label: "ModelRegistry.create()",
            status: "added",
            children: [],
          },
        ],
      },
    },
  ],
  ascii: "+ ModelRegistry.create()",
});

const makePi = () => ({ sendUserMessage: vi.fn() }) as unknown as ExtensionAPI;
const makeCtx = () => ({ cwd: "/repo" }) as unknown as ExtensionContext;

describe("maybeSendCallflowSummary", () => {
  it("sends a formatted summary follow-up on success", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: diffStdout,
    });
    const pi = makePi();
    const sent = await maybeSendCallflowSummary(pi, makeCtx(), "abc123");

    expect(sent).toBe(true);
    const send = vi.mocked(pi.sendUserMessage);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain(
      "PiService.createAgentSession: +1 / -0",
    );
    expect(send.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp" });
  });

  it("sends the no-changes notice when nothing changed", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: JSON.stringify({
        mode: "diff",
        from: "abc123",
        to: "working tree",
        trees: [],
        ascii: "",
      }),
    });
    const pi = makePi();
    const sent = await maybeSendCallflowSummary(pi, makeCtx(), "abc123");

    expect(sent).toBe(true);
    expect(String(vi.mocked(pi.sendUserMessage).mock.calls[0]?.[0])).toContain(
      "未检测到调用流变化",
    );
  });

  it("skips silently when calldiff is unavailable", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "error",
      code: "binary-not-found",
      message: "nope",
    });
    const pi = makePi();
    const sent = await maybeSendCallflowSummary(pi, makeCtx(), "abc123");

    expect(sent).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("skips silently on unparseable output", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: "not json",
    });
    const pi = makePi();
    const sent = await maybeSendCallflowSummary(pi, makeCtx(), "abc123");

    expect(sent).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("binds the wait hard and disables the npx fallback (event-handler safety)", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: diffStdout,
    });
    const pi = makePi();
    await maybeSendCallflowSummary(pi, makeCtx(), "abc123");

    expect(runCalldiffJson).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "diff",
        from: "abc123",
        timeoutMs: 15_000,
        preferNpxFallback: false,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Shell integration: captureGitHead (real git, via the shared seam)  */
/* ------------------------------------------------------------------ */

describe("captureGitHead", () => {
  it("returns the current HEAD in a git work tree", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capture-head-"));
    try {
      execSync("git init -q", { cwd: repoRoot });
      execSync("git config user.email test@example.com", { cwd: repoRoot });
      execSync("git config user.name test", { cwd: repoRoot });
      execSync("git commit --allow-empty -qm init", { cwd: repoRoot });

      const head = captureGitHead(repoRoot);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns null outside a git work tree", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-none-"));
    try {
      expect(captureGitHead(emptyDir)).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
