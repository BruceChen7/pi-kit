import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { resolveFeatureCommandRuntime } from "../runtime.js";
import {
  buildFeatureListNotifyMessage,
  loadFeatureRecordsFromWt,
} from "./shared.js";

export async function runFeatureListCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runtime = resolveFeatureCommandRuntime({ pi, ctx });
  if (!runtime) {
    return;
  }

  const { repoRoot, runWt } = runtime;

  const records = await loadFeatureRecordsFromWt({
    ctx,
    repoRoot,
    runWt,
  });
  if (!records) return;

  ctx.ui.notify(buildFeatureListNotifyMessage(records), "info");
}
