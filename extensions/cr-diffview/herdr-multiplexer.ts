import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
  CloseReviewViewTarget,
  CrMultiplexer,
  CrReviewViewLaunch,
  ExecResult,
  OpenReviewViewResult,
} from "./core.ts";
import { CR_TMUX_WINDOW_NAME_PREFIX } from "./core.ts";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const nestedRecord = (
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null => asRecord(value?.[key]);

const nestedString = (
  value: Record<string, unknown> | null,
  key: string,
): string => {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : "";
};

const parseHerdrCreateTab = (
  stdout: string,
): { tabId: string; paneId: string } | null => {
  try {
    const root = asRecord(JSON.parse(stdout));
    const result = nestedRecord(root, "result") ?? root;
    const tab = nestedRecord(result, "tab");
    const rootPane = nestedRecord(result, "root_pane");
    const tabId = nestedString(tab, "tab_id") || nestedString(tab, "id");
    const paneId =
      nestedString(rootPane, "pane_id") || nestedString(rootPane, "id");

    return tabId && paneId ? { tabId, paneId } : null;
  } catch {
    return null;
  }
};

type HerdrTab = { tabId: string; label: string };

const parseHerdrTabList = (stdout: string): HerdrTab[] => {
  try {
    const root = asRecord(JSON.parse(stdout));
    const result = nestedRecord(root, "result") ?? root;
    const tabs = result?.tabs;
    if (!Array.isArray(tabs)) return [];

    return tabs.flatMap((tabValue) => {
      const tab = asRecord(tabValue);
      const tabId = nestedString(tab, "tab_id") || nestedString(tab, "id");
      const label = nestedString(tab, "label");
      return tabId ? [{ tabId, label }] : [];
    });
  } catch {
    return [];
  }
};

const buildHerdrTabListArgs = (
  env: Record<string, string | undefined>,
): string[] => {
  const args = ["tab", "list"];
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (workspaceId) args.push("--workspace", workspaceId);
  return args;
};

export const createHerdrMultiplexer = (
  pi: ExtensionAPI,
  env: Record<string, string | undefined>,
): CrMultiplexer => {
  const resolveReviewViewId = async (
    target: CloseReviewViewTarget = {},
  ): Promise<string> => {
    if (target.reviewViewId) return target.reviewViewId;

    const reviewViewName = await target.resolveReviewViewName?.();
    return reviewViewName || CR_TMUX_WINDOW_NAME_PREFIX;
  };

  const closeResolvedReviewView = async (
    reviewViewId: string,
  ): Promise<ExecResult> => {
    const closeResult = (await pi.exec("herdr", [
      "tab",
      "close",
      reviewViewId,
    ])) as ExecResult;
    if (closeResult.code === 0) return closeResult;

    const listResult = (await pi.exec(
      "herdr",
      buildHerdrTabListArgs(env),
    )) as ExecResult;
    if (listResult.code !== 0) return closeResult;

    const matchingTab = parseHerdrTabList(listResult.stdout).find(
      (tab) => tab.tabId === reviewViewId || tab.label === reviewViewId,
    );
    if (!matchingTab || matchingTab.tabId === reviewViewId) return closeResult;

    return pi.exec("herdr", [
      "tab",
      "close",
      matchingTab.tabId,
    ]) as Promise<ExecResult>;
  };

  const closeReviewView = async (
    target?: CloseReviewViewTarget,
  ): Promise<ExecResult> =>
    closeResolvedReviewView(await resolveReviewViewId(target));

  return {
    type: "herdr",
    label: "herdr",
    isAvailable: () => env.HERDR_ENV === "1",
    async openReviewView(
      reviewViewName: string,
      launch: CrReviewViewLaunch,
    ): Promise<OpenReviewViewResult> {
      const originViewId = env.HERDR_TAB_ID ?? "";
      const createArgs = ["tab", "create", "--cwd", launch.cwd];
      const workspaceId = env.HERDR_WORKSPACE_ID;
      if (workspaceId) createArgs.push("--workspace", workspaceId);
      createArgs.push("--label", reviewViewName, "--no-focus");
      for (const [key, value] of Object.entries(launch.env)) {
        createArgs.push("--env", `${key}=${value}`);
      }

      const createResult = (await pi.exec("herdr", createArgs)) as ExecResult;
      if (createResult.code !== 0) {
        return { ...createResult, reviewViewId: "", originViewId };
      }

      const created = parseHerdrCreateTab(createResult.stdout);
      if (!created) {
        return {
          code: 1,
          stdout: createResult.stdout,
          stderr: "Failed to parse herdr tab create response",
          reviewViewId: "",
          originViewId,
        };
      }

      const runResult = (await pi.exec("herdr", [
        "pane",
        "run",
        created.paneId,
        launch.command,
      ])) as ExecResult;

      if (runResult.code !== 0) {
        await closeResolvedReviewView(created.tabId);
      }

      return {
        ...runResult,
        reviewViewId: created.tabId,
        originViewId,
      };
    },
    closeReviewView,
    focusView: (viewId: string): Promise<ExecResult> =>
      pi.exec("herdr", ["tab", "focus", viewId]) as Promise<ExecResult>,
  };
};
