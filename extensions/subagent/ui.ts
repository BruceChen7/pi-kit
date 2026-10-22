/**
 * /agents 命令（Shell）。
 *
 * 列表用 `ctx.ui.select`，会话视图用 overlay。宿主不支持自定义面板时
 * （pi-web / headless / -p）退化成 notify，而不是假装能进去。
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { resolveUiHostProfile } from "../shared/ui-host.ts";
import { findRun, renderTranscript } from "./core.ts";
import { FleetOverlay } from "./fleet-overlay.ts";
import type { SubagentRuntime } from "./index.ts";
import {
  renderEmptyFleetMessage,
  renderFleetFallback,
  renderRunOptions,
} from "./view.ts";

export function registerAgentsCommand(
  pi: ExtensionAPI,
  runtime: SubagentRuntime,
): void {
  pi.registerCommand("agents", {
    description: "List subagent runs, open one, and steer it",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = runtime.readState();
      const options = renderRunOptions(state, Date.now());

      if (options.length === 0) {
        ctx.ui.notify(renderEmptyFleetMessage(state), "info");
        return;
      }

      const host = resolveUiHostProfile({
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        envOverride: process.env.PI_KIT_UI_HOST,
      });

      if (!host.customPanels || !host.dialogs) {
        ctx.ui.notify(renderFleetFallback(state), "info");
        return;
      }

      const picked = await ctx.ui.select(
        "Subagent runs",
        options.map((option) => option.label),
      );
      const chosen = options.find((option) => option.label === picked);
      if (!chosen) return;
      const runId = chosen.runId;

      const run = findRun(runtime.readState(), runId);
      if (!run) {
        ctx.ui.notify(`run ${runId} disappeared`, "warning");
        return;
      }

      const answer = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) =>
          new FleetOverlay(
            tui,
            theme,
            {
              readLines: () => renderTranscript(run),
              onSubmit: (value) => done(value),
              onDismiss: () => done(undefined),
            },
            {
              chrome: host.panelChrome,
              title: `subagent · ${run.agent} ${run.runId}`,
              hint: "type to steer · enter send · esc close",
            },
          ),
        {
          overlay: true,
          overlayOptions: {
            width: "78%",
            minWidth: 60,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
        },
      );

      if (!answer?.trim()) return;

      const delivered = await runtime.steer(runId, answer);
      ctx.ui.notify(
        delivered
          ? `steered ${runId}`
          : `${runId} is no longer running; steer not delivered`,
        delivered ? "info" : "warning",
      );
    },
  });
}
