import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { maybeSwitchToWorktreeSession } from "./shared.js";

const createTempDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const createFeatureRecord = (worktreePath: string) => ({
  slug: "feature-parent-cwd",
  branch: "feature-parent-cwd",
  worktreePath,
  status: "active" as const,
  createdAt: "2026-04-21T00:00:00.000Z",
  updatedAt: "2026-04-21T00:00:00.000Z",
});

describe("maybeSwitchToWorktreeSession", () => {
  it("aligns the parent process cwd after switching to the worktree session", async () => {
    const initialCwd = process.cwd();
    const sourceCwd = createTempDir("pi-kit-fw-parent-cwd-source-");
    const worktreePath = createTempDir("pi-kit-fw-parent-cwd-worktree-");
    const sessionManager = SessionManager.create(sourceCwd);
    sessionManager.appendCustomEntry("test", { ready: true });

    let stale = false;
    const notify = vi.fn(() => {
      if (stale) {
        throw new Error(
          "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
        );
      }
    });
    const replacementNotify = vi.fn();
    const switchSession = vi.fn(
      async (
        _sessionPath: string,
        options?: { withSession?: (ctx: unknown) => Promise<void> },
      ) => {
        stale = true;
        await options?.withSession?.({
          ui: { notify: replacementNotify },
        });
        return { cancelled: false };
      },
    );

    process.chdir(sourceCwd);

    try {
      const result = await maybeSwitchToWorktreeSession({
        ctx: {
          ui: { notify },
          sessionManager,
          switchSession,
        } as unknown as ExtensionCommandContext,
        record: createFeatureRecord(worktreePath),
        worktreePath,
        enabled: true,
      });

      expect(result.switched).toBe(true);
      expect(fs.realpathSync(process.cwd())).toBe(
        fs.realpathSync(worktreePath),
      );
      expect(switchSession).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
      expect(replacementNotify).not.toHaveBeenCalled();
    } finally {
      process.chdir(initialCwd);
    }
  });
});
