import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { consoleLogger, type KanbanLogger } from "./logger.ts";
import type { IssueSource, KanbanIssue } from "./todo-source.ts";

export type FeatureRunState = "launching" | "running" | "error" | "stopped";

export type FeatureRun = {
  featureId: string;
  issueId: string;
  originProvider: string;
  originId: string;
  branch: string;
  worktreePath: string;
  tmuxSession: string;
  tmuxWindow: string;
  agentCommand: string;
  state: FeatureRunState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeGateway = {
  ensureFeatureWorktree(input: {
    repoRoot: string;
    slug: string;
    baseBranch: string;
    branch: string;
  }): Promise<{ branch: string; worktreePath: string }>;
};

export type TmuxGateway = {
  launchCommand(input: {
    cwd: string;
    windowName: string;
    command: string;
  }): Promise<{ session: string; window: string }>;
};

export type LaunchIssueRef = {
  originProvider: "todo-workflow";
  originId: string;
};

export type FeatureLaunchServiceOptions = {
  rootDir: string;
  repoRoot: string;
  issueSource: IssueSource;
  worktree: WorktreeGateway;
  tmux: TmuxGateway;
  socketPath?: string;
  logger?: KanbanLogger;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

class FeatureRunStore {
  private readonly runsDir: string;

  constructor(rootDir: string) {
    this.runsDir = path.join(rootDir, "runs");
  }

  async get(featureId: string): Promise<FeatureRun | null> {
    try {
      return JSON.parse(
        await readFile(this.pathFor(featureId), "utf8"),
      ) as FeatureRun;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async write(run: FeatureRun): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    const filePath = this.pathFor(run.featureId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  }

  private pathFor(featureId: string): string {
    return path.join(this.runsDir, `${featureId}.json`);
  }
}

function windowNameFor(featureId: string): string {
  return `kw-${featureId}`.slice(0, 80);
}

function requireLaunchWorkBranch(issue: KanbanIssue): string {
  const branch = issue.workBranch?.trim();
  if (!branch) {
    throw new Error("launch work branch is required");
  }
  return branch;
}

function buildAgentCommand(input: {
  issue: KanbanIssue;
  featureId: string;
  socketPath: string | null;
}): string {
  const env = [
    `KANBAN_FEATURE_ID=${input.featureId}`,
    `KANBAN_ISSUE_ID=${input.issue.issueId}`,
    `KANBAN_ORIGIN_PROVIDER=${input.issue.originProvider}`,
    `KANBAN_ORIGIN_ID=${input.issue.originId}`,
    ...(input.socketPath ? [`KANBAN_SOCKET=${input.socketPath}`] : []),
  ];
  const prompt = `Implement requirement: ${input.issue.title}`.replace(
    /"/g,
    '\\"',
  );
  return `${env.join(" ")} pi "${prompt}"`;
}

export class FeatureLaunchService {
  private readonly runs: FeatureRunStore;
  private readonly repoRoot: string;
  private readonly issueSource: IssueSource;
  private readonly worktree: WorktreeGateway;
  private readonly tmux: TmuxGateway;
  private readonly socketPath: string | null;
  private readonly logger: KanbanLogger;

  constructor(options: FeatureLaunchServiceOptions) {
    this.runs = new FeatureRunStore(options.rootDir);
    this.repoRoot = options.repoRoot;
    this.issueSource = options.issueSource;
    this.worktree = options.worktree;
    this.tmux = options.tmux;
    this.socketPath = options.socketPath ?? null;
    this.logger = options.logger ?? consoleLogger;
  }

  async launch(ref: LaunchIssueRef): Promise<FeatureRun> {
    this.logger.info("launch requested", ref);
    const issue = await this.requireIssue(ref);
    const featureId = issue.slug;
    const existing = await this.runs.get(featureId);
    if (existing?.state === "running") {
      this.logger.info("existing run reused", {
        issueId: issue.issueId,
        featureId,
        tmuxWindow: existing.tmuxWindow,
      });
      return existing;
    }
    if (issue.status !== "in-box") {
      throw new Error("only in-box issues can be launched");
    }

    const workBranch = requireLaunchWorkBranch(issue);
    const worktree = await this.worktree.ensureFeatureWorktree({
      repoRoot: issue.repoRoot,
      slug: issue.slug,
      baseBranch: issue.baseBranch,
      branch: workBranch,
    });
    const logMeta = {
      issueId: issue.issueId,
      originProvider: issue.originProvider,
      originId: issue.originId,
      featureId,
    };
    this.logger.info("worktree ready", {
      ...logMeta,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
    });
    const agentCommand = buildAgentCommand({
      issue,
      featureId,
      socketPath: this.socketPath,
    });
    const tmuxWindow = await this.tmux.launchCommand({
      cwd: worktree.worktreePath,
      windowName: windowNameFor(featureId),
      command: agentCommand,
    });
    this.logger.info("agent command launched", {
      ...logMeta,
      tmuxSession: tmuxWindow.session,
      tmuxWindow: tmuxWindow.window,
    });

    const now = new Date().toISOString();
    await this.issueSource.markStarted(this.repoRoot, {
      originId: issue.originId,
      sourceBranch: issue.baseBranch,
      workBranch: worktree.branch,
      worktreePath: worktree.worktreePath,
    });

    const run: FeatureRun = {
      featureId,
      issueId: issue.issueId,
      originProvider: issue.originProvider,
      originId: issue.originId,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      tmuxSession: tmuxWindow.session,
      tmuxWindow: tmuxWindow.window,
      agentCommand,
      state: "running",
      error: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.runs.write(run);
    return run;
  }

  private async requireIssue(ref: LaunchIssueRef): Promise<KanbanIssue> {
    if (ref.originProvider !== "todo-workflow") {
      throw new Error(`unsupported issue source: ${ref.originProvider}`);
    }
    const issue = await this.issueSource.get(this.repoRoot, ref.originId);
    if (!issue) {
      throw new Error(`requirement not found: ${ref.originId}`);
    }
    return issue;
  }
}
