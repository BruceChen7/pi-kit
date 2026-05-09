import { mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createRepoGitRunner,
  type GitRunner,
  listLocalBranches,
  listRemoteBranches,
} from "../shared/git.ts";
import { FeatureWorkflowGateway, TmuxGateway } from "./gateways.ts";
import { FeatureLaunchService } from "./launch-service.ts";
import { consoleLogger, type KanbanLogger } from "./logger.ts";
import {
  createError,
  createSuccess,
  JsonLineCodec,
  type RpcRequest,
} from "./protocol.ts";
import { TodoWorkflowSource } from "./todo-source.ts";

export function defaultKanbanRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "kanban-worktree");
}

export function defaultSocketPath(repoRoot: string = process.cwd()): string {
  const repoHash = Buffer.from(repoRoot).toString("base64url").slice(0, 32);
  return path.join(defaultKanbanRoot(), "run", `${repoHash}.sock`);
}

export type KanbanDaemonOptions = {
  rootDir?: string;
  socketPath?: string;
  repoRoot?: string;
  git?: GitRunner;
};

type BranchListResult = {
  branches: string[];
  defaultBranch: string;
};

function readLaunchRef(params: {
  originProvider?: "todo-workflow";
  originId?: string;
  issueId?: string;
}): { originProvider: "todo-workflow"; originId: string } {
  if (params.originProvider === "todo-workflow" && params.originId) {
    return { originProvider: params.originProvider, originId: params.originId };
  }
  if (params.issueId?.startsWith("todo-workflow:")) {
    return {
      originProvider: "todo-workflow",
      originId: params.issueId.slice("todo-workflow:".length),
    };
  }
  throw new Error("features.launch requires todo-workflow origin provider/id");
}

function readRemoveRef(params: {
  originProvider?: string;
  originId?: string;
  issueId?: string;
}): { originProvider: "todo-workflow"; originId: string } {
  if (params.originProvider === "todo-workflow" && params.originId) {
    return { originProvider: params.originProvider, originId: params.originId };
  }
  if (params.issueId?.startsWith("todo-workflow:")) {
    return {
      originProvider: "todo-workflow",
      originId: params.issueId.slice("todo-workflow:".length),
    };
  }
  throw new Error(
    "requirements.remove requires todo-workflow origin provider/id",
  );
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeBranches(branches: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    const normalized = trimToNull(branch);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function readRemoteDefaultBranch(run: GitRunner): string | null {
  const result = run([
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (result.exitCode !== 0) return null;
  const branch = trimToNull(result.stdout);
  return branch?.startsWith("origin/")
    ? branch.slice("origin/".length)
    : branch;
}

function chooseDefaultBranch(branches: string[], run: GitRunner): string {
  const remoteDefault = readRemoteDefaultBranch(run);
  if (remoteDefault && branches.includes(remoteDefault)) return remoteDefault;
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return branches[0] ?? "main";
}

function listBaseBranches(run: GitRunner): BranchListResult {
  const branches = dedupeBranches([
    ...listLocalBranches(run),
    ...listRemoteBranches(run, "origin"),
  ]);
  const fallbackBranches = branches.length > 0 ? branches : ["main"];
  return {
    branches: fallbackBranches,
    defaultBranch: chooseDefaultBranch(fallbackBranches, run),
  };
}

export class KanbanDaemon {
  private readonly rootDir: string;
  private readonly socketPath: string;
  private readonly repoRoot: string;
  private readonly issueSource: TodoWorkflowSource;
  private readonly logger: KanbanLogger;
  private readonly git: GitRunner;

  constructor(options: KanbanDaemonOptions = {}) {
    this.rootDir = options.rootDir ?? defaultKanbanRoot();
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.logger = consoleLogger;
    this.git = options.git ?? createRepoGitRunner(this.repoRoot);
    this.issueSource = new TodoWorkflowSource({
      resolveBaseBranch: () => listBaseBranches(this.git).defaultBranch,
    });
  }

  async listen(): Promise<void> {
    this.logger.info("daemon starting", {
      rootDir: this.rootDir,
      socketPath: this.socketPath,
      repoRoot: this.repoRoot,
    });
    await mkdir(path.dirname(this.socketPath), { recursive: true });
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    this.logger.info("daemon listening", { socketPath: this.socketPath });
  }

  private handleSocket(socket: Socket): void {
    const codec = new JsonLineCodec();
    socket.on("data", async (chunk) => {
      for (const raw of codec.push(chunk)) {
        const request = raw as RpcRequest;
        this.logger.info("rpc request", {
          id: request.id ?? null,
          method: request.method,
        });
        const response = await this.dispatch(request);
        socket.write(codec.encode(response));
      }
    });
  }

  private async dispatch(request: RpcRequest): Promise<unknown> {
    try {
      if (request.method === "requirements.create") {
        const params = request.params as
          | { title?: string; baseBranch?: string; workBranch?: string }
          | undefined;
        if (!params?.title) {
          throw new Error("requirements.create requires title");
        }
        const workBranch = trimToNull(params.workBranch);
        if (!workBranch) {
          throw new Error("requirements.create requires workBranch");
        }
        const baseBranch = trimToNull(params.baseBranch);
        return createSuccess(
          request.id ?? null,
          await this.issueSource.create(this.repoRoot, params.title, {
            ...(baseBranch ? { baseBranch } : {}),
            workBranch,
          }),
        );
      }
      if (request.method === "requirements.list") {
        return createSuccess(
          request.id ?? null,
          await this.issueSource.list(this.repoRoot),
        );
      }
      if (request.method === "requirements.remove") {
        const params = request.params as {
          originProvider?: string;
          originId?: string;
          issueId?: string;
        };
        const ref = readRemoveRef(params);
        return createSuccess(
          request.id ?? null,
          await this.issueSource.remove(this.repoRoot, ref.originId),
        );
      }
      if (request.method === "branches.list") {
        return createSuccess(request.id ?? null, listBaseBranches(this.git));
      }
      if (request.method === "features.launch") {
        const params = request.params as {
          originProvider?: "todo-workflow";
          originId?: string;
          issueId?: string;
        };
        const service = new FeatureLaunchService({
          rootDir: this.rootDir,
          repoRoot: this.repoRoot,
          issueSource: this.issueSource,
          worktree: new FeatureWorkflowGateway(this.logger),
          tmux: new TmuxGateway("pi-kanban", this.logger),
          socketPath: this.socketPath,
          logger: this.logger,
        });
        return createSuccess(
          request.id ?? null,
          await service.launch(readLaunchRef(params)),
        );
      }
      return createError(
        request.id ?? null,
        `unknown method: ${request.method}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("rpc failed", {
        id: request.id ?? null,
        method: request.method,
        error: message,
      });
      return createError(request.id ?? null, message);
    }
  }
}
