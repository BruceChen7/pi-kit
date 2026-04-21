import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSettingsCache } from "../shared/settings.js";
import extension from "./index.js";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): void {
  spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function createRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-kanban-cmd-"));
  tempDirs.push(repoRoot);
  runGit(repoRoot, ["init"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n", "utf-8");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

afterEach(() => {
  clearSettingsCache();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForStatus(
  statusCommand: (args: string, ctx: unknown) => Promise<void>,
  requestId: string,
  ctx: unknown,
  notifications: Array<{ message: string; level: string }>,
): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await statusCommand(requestId, ctx);
    const payload = JSON.parse(notifications.at(-1)?.message ?? "{}") as {
      status: string;
    };
    if (payload.status === "success" || payload.status === "failed") {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`request '${requestId}' did not reach a terminal state`);
}

describe("kanban orchestrator commands", () => {
  it("starts, reports, and stops embedded runtime server", async () => {
    const repoRoot = createRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec: vi.fn(),
      sendUserMessage: vi.fn(),
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const start = commands.get("kanban-runtime-start");
    const status = commands.get("kanban-runtime-status");
    const stop = commands.get("kanban-runtime-stop");
    expect(start).toBeTypeOf("function");
    expect(status).toBeTypeOf("function");
    expect(stop).toBeTypeOf("function");
    if (!start || !status || !stop) return;

    const ctx = {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    };

    await start("--port 0 --token test-token", ctx);
    const started = JSON.parse(notifications.at(-1)?.message ?? "{}") as {
      running: boolean;
      baseUrl: string;
    };
    expect(started.running).toBe(true);
    expect(started.baseUrl).toContain("http://127.0.0.1:");

    await status("", ctx);
    const statusJson = JSON.parse(notifications.at(-1)?.message ?? "{}") as {
      running: boolean;
    };
    expect(statusJson.running).toBe(true);

    await stop("", ctx);
    const stopped = JSON.parse(notifications.at(-1)?.message ?? "{}") as {
      running: boolean;
    };
    expect(stopped.running).toBe(false);
  });

  it("starts runtime without generating token when --token is omitted", async () => {
    const repoRoot = createRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec: vi.fn(),
      sendUserMessage: vi.fn(),
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const start = commands.get("kanban-runtime-start");
    const stop = commands.get("kanban-runtime-stop");
    expect(start).toBeTypeOf("function");
    expect(stop).toBeTypeOf("function");
    if (!start || !stop) return;

    const ctx = {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    };

    await start("--port 0", ctx);
    const started = JSON.parse(notifications.at(-1)?.message ?? "{}") as {
      running: boolean;
      token: string;
    };
    expect(started.running).toBe(true);
    expect(started.token).toBe("");

    await stop("", ctx);
  });

  it("executes apply then custom-prompt through registered commands", async () => {
    const repoRoot = createRepo();
    fs.mkdirSync(path.join(repoRoot, "workitems"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "workitems", "features.kanban.md"),
      [
        "## Spec",
        "",
        "- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->",
      ].join("\n"),
      "utf-8",
    );
    fs.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      JSON.stringify(
        {
          featureWorkflow: {
            guards: {
              requireCleanWorkspace: false,
              requireFreshBase: false,
            },
            defaults: {
              autoSwitchToWorktreeSession: false,
            },
            ignoredSync: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const sendUserMessage = vi.fn();

    const wtExec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("switch") && args.includes("--create")) {
        const branch =
          args[args.indexOf("--create") + 1] ?? "main--feat-checkout-v2";
        const worktreePath = path.join(repoRoot, ".wt", branch);
        fs.mkdirSync(worktreePath, { recursive: true });
        runGit(repoRoot, ["branch", branch, "main"]);

        return {
          code: 0,
          stdout: JSON.stringify({ action: "created", path: worktreePath }),
          stderr: "",
        };
      }

      if (args.includes("switch") && !args.includes("--create")) {
        return {
          code: 0,
          stdout: JSON.stringify({ action: "switched", path: repoRoot }),
          stderr: "",
        };
      }

      if (args.includes("list") && args.includes("--format")) {
        return {
          code: 0,
          stdout: "[]",
          stderr: "",
        };
      }

      throw new Error(`Unexpected wt args: ${args.join(" ")}`);
    });

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec: wtExec,
      sendUserMessage,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const execute = commands.get("kanban-action-execute");
    const status = commands.get("kanban-action-status");
    const runtimeStatus = commands.get("kanban-runtime-status");
    expect(execute).toBeTypeOf("function");
    expect(status).toBeTypeOf("function");
    expect(runtimeStatus).toBeTypeOf("function");
    if (!execute || !status || !runtimeStatus) return;

    const ctx = {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    };

    await execute("apply feat-checkout-v2", ctx);
    const queued = notifications.at(-1)?.message ?? "";
    const queuedPayload = JSON.parse(queued) as {
      requestId: string;
      status: string;
    };
    expect(queuedPayload.status).toBe("queued");

    await runtimeStatus("", ctx);
    const runtimeStatusPayload = JSON.parse(
      notifications.at(-1)?.message ?? "{}",
    ) as {
      running: boolean;
      baseUrl: string;
    };
    expect(runtimeStatusPayload.running).toBe(true);
    expect(runtimeStatusPayload.baseUrl).toContain("http://127.0.0.1:");

    const statusPayload = await waitForStatus(
      status,
      queuedPayload.requestId,
      ctx,
      notifications,
    );
    expect(statusPayload.status).toBe("success");

    const sidecarPath = path.join(
      repoRoot,
      "workitems",
      ".feature-cards",
      "feat-checkout-v2.json",
    );
    expect(fs.existsSync(sidecarPath)).toBe(true);

    await execute(
      'custom-prompt feat-checkout-v2 --prompt "please summarize current plan"',
      ctx,
    );
    const queuedPrompt = notifications.at(-1)?.message ?? "";
    const queuedPromptPayload = JSON.parse(queuedPrompt) as {
      requestId: string;
      status: string;
    };
    expect(queuedPromptPayload.status).toBe("queued");

    const promptStatusPayload = await waitForStatus(
      status,
      queuedPromptPayload.requestId,
      ctx,
      notifications,
    );
    expect(promptStatusPayload.status).toBe("success");

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("[KANBAN CARD CONTEXT]"),
      { deliverAs: "followUp" },
    );
  });
});
