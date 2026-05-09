import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { defaultSocketPath } from "./daemon.ts";
import { openGlimpseKanban } from "./glimpse-host.ts";
import { createKanbanLogger } from "./logger.ts";
import { sendJsonLineRequest } from "./protocol.ts";

let child: ChildProcess | null = null;
const log = createKanbanLogger("extension");

type Notify = (message: string, level?: "info" | "error") => void;

function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function probeSocket(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForSocket(socketPath: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await probeSocket(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function daemonArgs(input: {
  daemonPath: string;
  repoRoot: string;
  socketPath: string;
}): string[] {
  return [
    "--experimental-strip-types",
    input.daemonPath,
    "--socket",
    input.socketPath,
    "--repo-root",
    input.repoRoot,
  ];
}

export default function kanbanWorktreeExtension(pi: ExtensionAPI) {
  const daemonPath = fileURLToPath(new URL("./run-daemon.ts", import.meta.url));

  async function startDaemon(
    repoRoot: string,
    socketPath: string,
    notify: Notify,
  ) {
    log.info("start daemon requested", { socketPath, daemonPath, repoRoot });
    if (await probeSocket(socketPath)) {
      log.info("daemon already reachable", { socketPath });
      return true;
    }
    child = spawn(
      process.execPath,
      daemonArgs({ daemonPath, repoRoot, socketPath }),
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    log.info("daemon spawned", { pid: child.pid, socketPath, repoRoot });
    child.unref();
    if (await waitForSocket(socketPath)) {
      log.info("daemon socket ready", { socketPath });
      return true;
    }
    log.error("daemon socket wait timed out", { socketPath });
    notify("kanban-worktree daemon failed to start", "error");
    return false;
  }

  pi.registerCommand("kanban-worktree", {
    description:
      "Kanban worktree: start | status | open | create <title> | list",
    handler: async (args, ctx) => {
      const [sub = "start", ...rest] = splitArgs(args);
      const socketPath = defaultSocketPath(ctx.cwd);
      log.info("command received", { sub, cwd: ctx.cwd, socketPath });
      const notify: Notify = (message, level = "info") => {
        ctx.ui.notify(message, level);
      };

      if (sub === "start") {
        if (await probeSocket(socketPath)) {
          notify(`kanban-worktree already running: ${socketPath}`);
          return;
        }
        if (await startDaemon(ctx.cwd, socketPath, notify)) {
          notify(`kanban-worktree started: ${socketPath}`);
        }
        return;
      }

      if (sub === "open") {
        if (!(await startDaemon(ctx.cwd, socketPath, notify))) return;
        await openGlimpseKanban(socketPath);
        notify("kanban-worktree opened");
        return;
      }

      if (sub === "status") {
        notify(
          (await probeSocket(socketPath))
            ? "kanban-worktree running"
            : "not running",
        );
        return;
      }

      if (sub === "create") {
        const title = rest.join(" ").trim();
        if (!title) {
          notify("Usage: /kanban-worktree create <title>", "error");
          return;
        }
        log.info("create requirement requested", { title, socketPath });
        const response = await sendJsonLineRequest(socketPath, {
          id: "create",
          method: "requirements.create",
          params: {
            title,
            repoRoot: ctx.cwd,
            baseBranch: "main",
            acceptanceCriteria: [],
          },
        });
        notify(JSON.stringify(response));
        return;
      }

      if (sub === "list") {
        log.info("list requirements requested", { socketPath });
        notify(
          JSON.stringify(
            await sendJsonLineRequest(socketPath, {
              id: "list",
              method: "requirements.list",
            }),
          ),
        );
        return;
      }

      if (sub === "stop") {
        log.info("stop requested", { socketPath, pid: child?.pid ?? null });
        if (child) child.kill("SIGINT");
        child = null;
        spawnSync("rm", ["-f", socketPath]);
        notify("kanban-worktree stopped");
        return;
      }

      notify(`Unknown subcommand: ${sub}`, "error");
    },
  });
}
