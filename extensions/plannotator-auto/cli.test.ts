import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTempRepo,
  flushMicrotasks,
  mockPlannotatorSpawn,
  removeTempRepo,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// runCli owns the Herdr panel lifecycle end-to-end: it arms the panel open on
// start and closes the panel on any terminal verdict reported as "handled".
// These tests pin that contract at its single chokepoint — callers never wire
// close themselves. VITEST/NODE_ENV are stripped so the panel flow arms;
// ./terminal-browser.ts is partially mocked to observe open/close without
// spawning real panes.
// ---------------------------------------------------------------------------

const ENV_KEYS = ["VITEST", "NODE_ENV", "HERDR_ENV", "HERDR_PANE_ID"] as const;

const armHerdrEnv = () => {
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
};

const mockPanelModule = () => {
  const closeSpy = vi.fn();
  const shouldUseTerminalBrowser = vi.fn(async () => true);
  vi.doMock("./terminal-browser.ts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./terminal-browser.ts")>()),
    shouldUseTerminalBrowser,
    createTempReadyFile: vi.fn(
      async () => "/tmp/plannotator-cli-test.ready.jsonl",
    ),
    waitForReadyFile: vi.fn(async () => null),
    openUrlInHerdrTerminalBrowser: vi.fn(async () => {}),
    removeTempReadyFile: vi.fn(),
    closeReviewPanelOnTerminalDecision: closeSpy,
  }));
  return { closeSpy, shouldUseTerminalBrowser };
};

const ctxFor = (repoRoot: string) => ({
  cwd: repoRoot,
  sessionManager: { getSessionFile: () => `${repoRoot}/.git/session.json` },
});

const runAnnotate = async (
  repoRoot: string,
  options?: { signal?: AbortSignal; hostMode?: "browser" | "herdr-panel" },
) => {
  const cli = await import("./cli.ts");
  return cli.runPlannotatorAnnotateCli(ctxFor(repoRoot), `${repoRoot}/n.md`, {
    signal: options?.signal,
    timeoutMs: 1000,
    hostMode: options?.hostMode,
  });
};

describe("runCli Herdr panel lifecycle", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("closes the panel it armed when the CLI reports a terminal verdict", async () => {
    vi.resetModules();
    armHerdrEnv();
    mockPlannotatorSpawn({
      status: 0,
      stdout: JSON.stringify({
        decision: "annotated",
        feedback: "Please revise.",
      }),
    });
    const { closeSpy, shouldUseTerminalBrowser } = mockPanelModule();
    const repoRoot = await createTempRepo("cli-panel-close-denied-");

    try {
      // hostMode "herdr-panel" opts the Markdown review into the panel flow.
      const result = await runAnnotate(repoRoot, { hostMode: "herdr-panel" });

      // Denied (feedback) is a terminal verdict: panel flow armed → closed.
      expect(result.status).toBe("handled");
      await flushMicrotasks();
      expect(shouldUseTerminalBrowser).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ approved: false }),
        expect.objectContaining({ cwd: repoRoot }),
      );
    } finally {
      await removeTempRepo(repoRoot);
    }
  });

  it("never arms or closes a panel with the default browser host (HTML flows)", async () => {
    vi.resetModules();
    armHerdrEnv();
    mockPlannotatorSpawn({
      status: 0,
      stdout: JSON.stringify({ decision: "annotated", feedback: "Adjust." }),
    });
    const { closeSpy, shouldUseTerminalBrowser } = mockPanelModule();
    const repoRoot = await createTempRepo("cli-panel-html-");

    try {
      const result = await runAnnotate(repoRoot, { hostMode: "browser" });

      expect(result.status).toBe("handled");
      // Caller-level host opt-out (and the new default): no panel flow at
      // all — never probe, never close.
      await flushMicrotasks();
      expect(shouldUseTerminalBrowser).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      await removeTempRepo(repoRoot);
    }
  });

  it("keeps the panel on abort (not a terminal verdict)", async () => {
    vi.resetModules();
    armHerdrEnv();
    mockPlannotatorSpawn({
      status: 0,
      stdout: JSON.stringify({ decision: "annotated", feedback: "Late." }),
    });
    const { closeSpy } = mockPanelModule();
    const repoRoot = await createTempRepo("cli-panel-abort-");

    try {
      const controller = new AbortController();
      controller.abort();
      const result = await runAnnotate(repoRoot, {
        signal: controller.signal,
        hostMode: "herdr-panel",
      });

      // Aborted reviews are retried: the panel stays open.
      expect(result.status).toBe("aborted");
      await flushMicrotasks();
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      await removeTempRepo(repoRoot);
    }
  });
});
