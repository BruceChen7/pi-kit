import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  checkRepoDirty,
  DEFAULT_GIT_TIMEOUT_MS,
  getRepoRoot,
} from "../shared/git.js";
import { createLogger } from "../shared/logger.js";

import { buildBaseBranchCandidates } from "./base-branches.js";
import { loadFeatureWorkflowConfig } from "./config.js";
import {
  branchExists,
  createRepoGitRunner,
  getCurrentBranchName,
  listLocalBranches,
} from "./git.js";
import { checkBaseBranchFreshness } from "./guards.js";
import {
  buildFeatureBranchName,
  buildFeatureId,
  type FeatureType,
  slugifyFeatureName,
} from "./naming.js";
import {
  type FeatureRecord,
  listFeatureRecords,
  readFeatureRecord,
  writeFeatureRecord,
} from "./storage.js";
import { buildWtSwitchCreateArgs, parseWtJsonResult } from "./wt.js";

const log = createLogger("feature-workflow", { stderr: null });

const FEATURE_TYPES: FeatureType[] = ["feat", "fix", "chore", "spike"];

const OTHER_BASE_BRANCH = "Other…";

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

async function runWt(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await pi.exec("wt", ["-C", repoRoot, ...args]);
  return {
    code: result.code ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function formatFeatureList(records: FeatureRecord[]): string {
  if (records.length === 0) {
    return "No feature records found.";
  }

  const lines: string[] = [];
  lines.push("## Features");
  for (const record of records) {
    lines.push(
      `- ${record.id}  (branch: ${record.branch}, base: ${record.base})`,
    );
    lines.push(`  - path: ${record.worktreePath}`);
    lines.push(`  - updated: ${record.updatedAt}`);
  }
  return `${lines.join("\n")}\n`;
}

async function selectFeatureType(
  ctx: ExtensionCommandContext,
): Promise<FeatureType | null> {
  if (!ctx.hasUI) return null;
  const choice = await ctx.ui.select("Feature type:", FEATURE_TYPES);
  if (!choice) return null;
  return FEATURE_TYPES.includes(choice as FeatureType)
    ? (choice as FeatureType)
    : null;
}

async function selectBaseBranch(input: {
  ctx: ExtensionCommandContext;
  candidates: string[];
}): Promise<string | null> {
  const { ctx } = input;
  if (!ctx.hasUI) {
    return input.candidates[0] ?? null;
  }

  const options = [
    ...input.candidates.slice(0, 12),
    ...(input.candidates.length > 12 ? [OTHER_BASE_BRANCH] : []),
  ];

  const choice = await ctx.ui.select("Base branch:", options);
  if (choice === undefined) return null;

  if (choice === OTHER_BASE_BRANCH) {
    const manual = await ctx.ui.input("Base branch (local):", "");
    return trimToNull(manual);
  }

  return trimToNull(choice);
}

async function runFeatureStart(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const config = loadFeatureWorkflowConfig(ctx.cwd);
  if (!config.enabled) {
    ctx.ui.notify("feature-workflow is disabled", "info");
    return;
  }

  const timeoutMs = config.defaults.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const repoRoot = getRepoRoot(ctx.cwd, timeoutMs);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const runGit = createRepoGitRunner(repoRoot, timeoutMs);

  if (config.guards.requireCleanWorkspace) {
    const dirty = checkRepoDirty(repoRoot, timeoutMs);
    if (!dirty) {
      ctx.ui.notify("Failed to check git status", "warning");
      return;
    }

    if (dirty.summary.dirty) {
      ctx.ui.notify(
        `Repository is dirty (staged ${dirty.summary.staged}, unstaged ${dirty.summary.unstaged}, untracked ${dirty.summary.untracked}). Commit/stash first.`,
        "warning",
      );
      return;
    }
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("feature-start requires interactive UI", "error");
    return;
  }

  const type = await selectFeatureType(ctx);
  if (!type) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const name = trimToNull(await ctx.ui.input("Feature name:", ""));
  if (!name) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const slug = slugifyFeatureName(name);
  if (!slug) {
    ctx.ui.notify("Invalid feature name (empty slug)", "error");
    return;
  }

  const id = buildFeatureId({ type, slug });
  const branch = buildFeatureBranchName({ type, slug });

  if (config.guards.enforceBranchNaming) {
    const ok = /^(feat|fix|chore|spike)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(
      branch,
    );
    if (!ok) {
      ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
      return;
    }
  }

  if (branchExists(runGit, branch)) {
    ctx.ui.notify(`Branch already exists: ${branch}`, "error");
    return;
  }

  if (readFeatureRecord(repoRoot, id)) {
    ctx.ui.notify(`Feature record already exists: ${id}`, "error");
    return;
  }

  const currentBranch = getCurrentBranchName(runGit);
  const localBranches = listLocalBranches(runGit);
  const candidates = buildBaseBranchCandidates({
    currentBranch,
    localBranches,
  });

  const base = await selectBaseBranch({ ctx, candidates });
  if (!base) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  if (config.guards.requireFreshBase) {
    const freshness = checkBaseBranchFreshness({ runGit, baseBranch: base });
    if (!freshness.ok) {
      if (freshness.behind !== null) {
        ctx.ui.notify(
          `Base branch '${base}' is behind '${freshness.upstream}' by ${freshness.behind} commits. Update base branch first.`,
          "error",
        );
      } else {
        ctx.ui.notify(
          `Failed to verify freshness for base branch '${base}'.`,
          "error",
        );
      }
      return;
    }
  }

  ctx.ui.notify(`Creating worktree for ${branch}…`, "info");

  const wtResult = await runWt(
    pi,
    repoRoot,
    buildWtSwitchCreateArgs({
      branch,
      base,
    }),
  );

  if (wtResult.code !== 0) {
    const msg =
      trimToNull(wtResult.stderr) ??
      trimToNull(wtResult.stdout) ??
      "wt switch failed";
    ctx.ui.notify(msg, "error");
    log.error("wt switch --create failed", { branch, base, repoRoot, msg });
    return;
  }

  const wtJson = parseWtJsonResult(wtResult.stdout);
  const worktreePath =
    wtJson && typeof wtJson.path === "string" ? wtJson.path : "";

  const now = new Date().toISOString();
  const record: FeatureRecord = {
    id,
    name,
    type,
    slug,
    branch,
    base,
    worktreePath,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  writeFeatureRecord(repoRoot, record);

  const instructions: string[] = [];
  instructions.push(`# Feature created: ${id}`);
  instructions.push(`- branch: ${branch}`);
  instructions.push(`- base: ${base}`);
  if (worktreePath) {
    instructions.push(`- worktree: ${worktreePath}`);
  }
  instructions.push("");
  if (worktreePath) {
    instructions.push("Next:");
    instructions.push(`cd ${worktreePath}`);
    instructions.push(`# or: wt switch ${branch}`);
  } else {
    instructions.push("Next:");
    instructions.push(`wt switch ${branch}`);
  }
  instructions.push("");

  ctx.ui.setEditorText(`${instructions.join("\n")}\n`);
  ctx.ui.notify(`Feature worktree created: ${branch}`, "info");
}

async function runFeatureList(_pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const config = loadFeatureWorkflowConfig(ctx.cwd);
  if (!config.enabled) {
    ctx.ui.notify("feature-workflow is disabled", "info");
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, config.defaults.gitTimeoutMs);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const records = listFeatureRecords(repoRoot);
  ctx.ui.setEditorText(formatFeatureList(records));
  ctx.ui.notify(`Listed ${records.length} feature(s)`, "info");
}

function matchFeatureRecord(
  records: FeatureRecord[],
  query: string,
): FeatureRecord | null {
  const q = query.trim();
  if (!q) return null;
  return (
    records.find((r) => r.id === q) ??
    records.find((r) => r.slug === q) ??
    records.find((r) => r.branch === q) ??
    null
  );
}

async function runFeatureSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
) {
  const config = loadFeatureWorkflowConfig(ctx.cwd);
  if (!config.enabled) {
    ctx.ui.notify("feature-workflow is disabled", "info");
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, config.defaults.gitTimeoutMs);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const records = listFeatureRecords(repoRoot);
  if (records.length === 0) {
    ctx.ui.notify("No feature records found", "info");
    return;
  }

  let query = args[0] ?? "";
  if (!query && ctx.hasUI) {
    const choice = await ctx.ui.select(
      "Switch to feature:",
      records.map((r) => r.id),
    );
    if (choice === undefined) return;
    query = choice;
  }

  const record = matchFeatureRecord(records, query);
  if (!record) {
    ctx.ui.notify(`Unknown feature: ${query}`, "error");
    return;
  }

  const wtArgs = [
    "switch",
    record.branch,
    "--no-cd",
    "--format",
    "json",
    "--yes",
  ];

  const wtResult = await runWt(pi, repoRoot, wtArgs);
  if (wtResult.code !== 0) {
    const msg =
      trimToNull(wtResult.stderr) ??
      trimToNull(wtResult.stdout) ??
      "wt switch failed";
    ctx.ui.notify(msg, "error");
    return;
  }

  const wtJson = parseWtJsonResult(wtResult.stdout);
  const worktreePath =
    wtJson && typeof wtJson.path === "string"
      ? wtJson.path
      : record.worktreePath;

  const lines: string[] = [];
  lines.push(`# Feature: ${record.id}`);
  lines.push(`- branch: ${record.branch}`);
  lines.push(`- worktree: ${worktreePath || "(unknown)"}`);
  lines.push("");
  if (worktreePath) {
    lines.push("Next:");
    lines.push(`cd ${worktreePath}`);
    lines.push("# restart pi in that directory");
  }
  lines.push("");

  ctx.ui.setEditorText(`${lines.join("\n")}\n`);
  ctx.ui.notify(`Worktree ready: ${record.branch}`, "info");
}

async function runFeatureValidate(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
) {
  const config = loadFeatureWorkflowConfig(ctx.cwd);
  if (!config.enabled) {
    ctx.ui.notify("feature-workflow is disabled", "info");
    return;
  }

  const timeoutMs = config.defaults.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const repoRoot = getRepoRoot(ctx.cwd, timeoutMs);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const runGit = createRepoGitRunner(repoRoot, timeoutMs);
  const messages: string[] = [];

  const dirty = checkRepoDirty(repoRoot, timeoutMs);
  if (!dirty) {
    ctx.ui.notify("Failed to check git status", "warning");
    return;
  }
  messages.push(
    `dirty: ${dirty.summary.dirty ? "yes" : "no"} (staged ${dirty.summary.staged}, unstaged ${dirty.summary.unstaged}, untracked ${dirty.summary.untracked})`,
  );

  const currentBranch = getCurrentBranchName(runGit);
  const localBranches = listLocalBranches(runGit);
  const candidates = buildBaseBranchCandidates({
    currentBranch,
    localBranches,
  });

  const base = candidates[0] ?? null;
  if (base && config.guards.requireFreshBase) {
    const freshness = checkBaseBranchFreshness({ runGit, baseBranch: base });
    if (freshness.ok) {
      messages.push(`base freshness: ok (${base})`);
    } else if (freshness.behind !== null) {
      messages.push(
        `base freshness: FAIL (${base} behind ${freshness.upstream} by ${freshness.behind})`,
      );
    } else {
      messages.push(`base freshness: FAIL (${base}, unknown)`);
    }
  }

  ctx.ui.setEditorText(`${messages.map((m) => `- ${m}`).join("\n")}\n`);
  ctx.ui.notify("feature preflight complete", "info");
}

export default function featureWorkflowExtension(pi: ExtensionAPI) {
  pi.registerCommand("feature-start", {
    description: "Create a feature branch + worktree via Worktrunk",
    handler: async (_args, ctx) => runFeatureStart(pi, ctx),
  });

  pi.registerCommand("feature-list", {
    description: "List feature records for this repo",
    handler: async (_args, ctx) => runFeatureList(pi, ctx),
  });

  pi.registerCommand("feature-switch", {
    description: "Prepare switching to an existing feature worktree",
    handler: async (args, ctx) => runFeatureSwitch(pi, ctx, args),
  });

  pi.registerCommand("feature-validate", {
    description: "Run feature preflight checks",
    handler: async (_args, ctx) => runFeatureValidate(pi, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    if (!config.enabled) return;
    log.info("feature-workflow enabled", { cwd: ctx.cwd });
  });
}
