import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildCrTmuxKillWindowArgs,
  buildCrTmuxNewWindowArgs,
  buildCrTmuxSelectPaneArgs,
  type CrMultiplexer,
  type CrReviewViewLaunch,
  type ExecResult,
  type OpenReviewViewResult,
} from "./core.ts";

export const createTmuxMultiplexer = (
  pi: ExtensionAPI,
  env: Record<string, string | undefined>,
): CrMultiplexer => ({
  type: "tmux",
  label: "tmux",
  isAvailable: () => Boolean(env.TMUX),
  async openReviewView(
    reviewViewName: string,
    launch: CrReviewViewLaunch,
  ): Promise<OpenReviewViewResult> {
    const result = (await pi.exec(
      "tmux",
      buildCrTmuxNewWindowArgs(reviewViewName, launch.shellCommand),
    )) as ExecResult;

    return {
      ...result,
      reviewViewId: reviewViewName,
      originViewId: env.TMUX_PANE ?? "",
    };
  },
  closeReviewView: (reviewViewId: string): Promise<ExecResult> =>
    pi.exec(
      "tmux",
      buildCrTmuxKillWindowArgs(reviewViewId),
    ) as Promise<ExecResult>,
  focusView: (viewId: string): Promise<ExecResult> =>
    pi.exec("tmux", buildCrTmuxSelectPaneArgs(viewId)) as Promise<ExecResult>,
});
