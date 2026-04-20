import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { checkRepoDirty } from "../../shared/git.js";

import { checkBaseBranchFreshness } from "../guards.js";
import { resolveFeatureCommandRuntime } from "../runtime.js";
import {
  buildFeaturePreflightNotifyMessage,
  buildInferredBaseMessage,
  resolveInferredBaseBranch,
} from "./shared.js";

export async function runFeatureValidateCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runtime = resolveFeatureCommandRuntime({ pi, ctx });
  if (!runtime) {
    return;
  }

  const { config, timeoutMs, repoRoot, runGit } = runtime;
  const messages: string[] = [];

  const dirty = checkRepoDirty(repoRoot, timeoutMs);
  if (!dirty) {
    ctx.ui.notify("Failed to check git status", "warning");
    return;
  }

  messages.push(
    `dirty: ${dirty.summary.dirty ? "yes" : "no"} (staged ${dirty.summary.staged}, unstaged ${dirty.summary.unstaged}, untracked ${dirty.summary.untracked})`,
  );

  const { inference } = resolveInferredBaseBranch({ runGit });
  messages.push(buildInferredBaseMessage(inference));

  if (inference.kind === "resolved" && config.guards.requireFreshBase) {
    const freshness = checkBaseBranchFreshness({
      runGit,
      baseBranch: inference.branch,
    });
    if (freshness.ok) {
      messages.push(`base freshness: ok (${inference.branch})`);
    } else if (freshness.behind !== null) {
      messages.push(
        `base freshness: FAIL (${inference.branch} behind ${freshness.upstream} by ${freshness.behind})`,
      );
    } else {
      messages.push(`base freshness: FAIL (${inference.branch}, unknown)`);
    }
  }

  ctx.ui.notify(buildFeaturePreflightNotifyMessage(messages), "info");
}
