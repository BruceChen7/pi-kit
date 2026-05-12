import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { defaultMetadataPath, defaultSocketPath } from "./daemon-runtime.ts";
import {
  ensureKanbanDaemon,
  isKanbanDaemonRunning,
  stopAllKanbanDaemons,
  stopKanbanDaemon,
} from "./daemon-supervisor.ts";
import { openGlimpseKanban } from "./glimpse-host.ts";
import { createKanbanLogger } from "./logger.ts";
import { sendJsonLineRequest } from "./protocol.ts";

const log = createKanbanLogger("extension");

type Notify = (message: string, level?: "info" | "error") => void;

type CommandDaemonTarget = {
  repoRoot: string;
  socketPath: string;
  metadataPath: string;
};

function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export default function kanbanWorktreeExtension(pi: ExtensionAPI) {
  const daemonPath = fileURLToPath(new URL("./run-daemon.ts", import.meta.url));

  async function startDaemon(target: CommandDaemonTarget, notify: Notify) {
    log.info("start daemon requested", {
      ...target,
      daemonPath,
    });
    if (await ensureKanbanDaemon({ daemonPath, ...target })) {
      log.info("daemon socket ready", {
        socketPath: target.socketPath,
        metadataPath: target.metadataPath,
      });
      return true;
    }
    log.error("daemon socket wait timed out", target);
    notify("kanban-worktree daemon failed to start", "error");
    return false;
  }

  pi.registerCommand("kanban-worktree", {
    description:
      "Kanban worktree: start | status | open | create <title> | list | stop | stop-all",
    handler: async (args, ctx) => {
      const [sub = "start", ...rest] = splitArgs(args);
      const target = {
        repoRoot: ctx.cwd,
        socketPath: defaultSocketPath(ctx.cwd),
        metadataPath: defaultMetadataPath(ctx.cwd),
      };
      log.info("command received", {
        sub,
        cwd: ctx.cwd,
        socketPath: target.socketPath,
        metadataPath: target.metadataPath,
      });
      const notify: Notify = (message, level = "info") => {
        ctx.ui.notify(message, level);
      };

      if (sub === "start") {
        if (await startDaemon(target, notify)) {
          notify(`kanban-worktree started: ${target.socketPath}`);
        }
        return;
      }

      if (sub === "open") {
        if (!(await startDaemon(target, notify))) return;
        await openGlimpseKanban(target.socketPath);
        notify("kanban-worktree opened");
        return;
      }

      if (sub === "status") {
        notify(
          (await isKanbanDaemonRunning(target))
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
        if (!(await startDaemon(target, notify))) return;
        log.info("create requirement requested", {
          title,
          socketPath: target.socketPath,
        });
        const response = await sendJsonLineRequest(target.socketPath, {
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
        if (!(await startDaemon(target, notify))) return;
        log.info("list requirements requested", {
          socketPath: target.socketPath,
        });
        notify(
          JSON.stringify(
            await sendJsonLineRequest(target.socketPath, {
              id: "list",
              method: "requirements.list",
            }),
          ),
        );
        return;
      }

      if (sub === "stop") {
        log.info("stop requested", target);
        await stopKanbanDaemon(target);
        notify("kanban-worktree stopped");
        return;
      }

      if (sub === "stop-all") {
        log.info("stop-all requested", target);
        await stopAllKanbanDaemons();
        notify("kanban-worktree daemons stopped");
        return;
      }

      notify(`Unknown subcommand: ${sub}`, "error");
    },
  });
}
