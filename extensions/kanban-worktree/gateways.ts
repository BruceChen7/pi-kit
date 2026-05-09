import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { consoleLogger, type KanbanLogger } from "./logger.ts";

const execFileAsync = promisify(execFile);

export class FeatureWorkflowGateway {
  private readonly logger: KanbanLogger;

  constructor(logger: KanbanLogger = consoleLogger) {
    this.logger = logger;
  }

  async ensureFeatureWorktree(input: {
    repoRoot: string;
    slug: string;
    baseBranch: string;
    branch: string;
  }): Promise<{ branch: string; worktreePath: string }> {
    this.logger.info("worktree ensure requested", {
      repoRoot: input.repoRoot,
      slug: input.slug,
      baseBranch: input.baseBranch,
    });
    const { createFeatureWorktree, createProcessWtRunner } = await import(
      "../feature-workflow/worktree-gateway.ts"
    );
    const runWt = createProcessWtRunner(input.repoRoot);
    const result = await createFeatureWorktree(runWt, {
      branch: input.branch,
      base: input.baseBranch,
    });
    if (result.ok === false) {
      this.logger.error("worktree ensure failed", {
        branch: input.branch,
        baseBranch: input.baseBranch,
        error: result.message,
      });
      throw new Error(result.message);
    }
    this.logger.info("worktree ensure completed", {
      branch: input.branch,
      worktreePath: result.worktreePath,
    });
    return { branch: input.branch, worktreePath: result.worktreePath };
  }
}

export class TmuxGateway {
  private readonly fallbackSession: string;
  private readonly logger: KanbanLogger;

  constructor(
    fallbackSession = "pi-kanban",
    logger: KanbanLogger = consoleLogger,
  ) {
    this.fallbackSession = fallbackSession;
    this.logger = logger;
  }

  async launchCommand(input: {
    cwd: string;
    windowName: string;
    command: string;
  }): Promise<{ session: string; window: string }> {
    this.logger.info("tmux launch command requested", {
      cwd: input.cwd,
      windowName: input.windowName,
    });
    const session = await this.resolveSession();
    const window = await this.allocateLaunchWindow(session, input.windowName);
    await execFileAsync("tmux", [
      "new-window",
      "-t",
      session,
      "-n",
      window,
      "-c",
      input.cwd,
      input.command,
    ]);
    await execFileAsync("tmux", [
      "select-window",
      "-t",
      `${session}:${window}`,
    ]);
    this.logger.info("tmux command launched", {
      session,
      window,
      requestedWindow: input.windowName,
      reusedWindowName: window !== input.windowName,
    });
    return { session, window };
  }

  private async resolveSession(): Promise<string> {
    if (process.env.TMUX) {
      this.logger.info("tmux using current session");
      const { stdout } = await execFileAsync("tmux", [
        "display-message",
        "-p",
        "#S",
      ]);
      return stdout.trim();
    }

    try {
      await execFileAsync("tmux", ["has-session", "-t", this.fallbackSession]);
      this.logger.info("tmux using fallback session", {
        session: this.fallbackSession,
        created: false,
      });
    } catch {
      this.logger.info("tmux creating fallback session", {
        session: this.fallbackSession,
      });
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        this.fallbackSession,
      ]);
    }
    return this.fallbackSession;
  }

  private async allocateLaunchWindow(
    session: string,
    requestedWindow: string,
  ): Promise<string> {
    if (!(await this.windowExists(session, requestedWindow))) {
      return requestedWindow;
    }

    const suffixBase = Date.now().toString(36);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? suffixBase : `${suffixBase}-${attempt}`;
      const candidate = this.windowNameWithSuffix(requestedWindow, suffix);
      if (!(await this.windowExists(session, candidate))) {
        this.logger.info("tmux launch window name already exists", {
          requestedWindow,
          window: candidate,
        });
        return candidate;
      }
    }

    throw new Error(`could not allocate tmux window for ${requestedWindow}`);
  }

  private windowNameWithSuffix(base: string, suffix: string): string {
    const decoratedSuffix = `-${suffix}`;
    return `${base.slice(0, 80 - decoratedSuffix.length)}${decoratedSuffix}`;
  }

  private async windowExists(
    session: string,
    window: string,
  ): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("tmux", [
        "list-windows",
        "-t",
        session,
        "-F",
        "#W",
      ]);
      return stdout.split(/\r?\n/).includes(window);
    } catch {
      return false;
    }
  }
}
