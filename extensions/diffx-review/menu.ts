import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

import {
  buildBaseBranchDiffArgs,
  buildCommitRangeDiffArgs,
  buildMergeBaseDiffArgs,
  buildSingleCommitDiffArgs,
  DIFFX_COMPARE_PRESET_OPTIONS,
  parseRawDiffArgs,
} from "./helpers.ts";
import type { DiffxComparePreset, GitCommitSummary } from "./types.ts";

const SELECT_LIST_MAX_VISIBLE = 10;
const COMMIT_SELECTION_LIMIT = 50;

const buildSelectListTheme = (theme: {
  fg: (token: string, text: string) => string;
}) => ({
  selectedPrefix: (text: string) => theme.fg("accent", text),
  selectedText: (text: string) => theme.fg("accent", text),
  description: (text: string) => theme.fg("muted", text),
  scrollInfo: (text: string) => theme.fg("dim", text),
  noMatch: (text: string) => theme.fg("warning", text),
});

const showSelectList = async (input: {
  ctx: ExtensionCommandContext;
  title: string;
  items: SelectItem[];
  searchable?: boolean;
  hint?: string;
  initialValue?: string;
}): Promise<string | null> => {
  if (!input.ctx.hasUI) {
    return null;
  }

  return input.ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold(input.title))));

    const selectList = new SelectList(
      input.items,
      Math.min(input.items.length, SELECT_LIST_MAX_VISIBLE),
      buildSelectListTheme(theme),
    );

    if (input.searchable) {
      selectList.searchable = true;
    }

    const initialIndex = input.initialValue
      ? input.items.findIndex((item) => item.value === input.initialValue)
      : -1;
    if (initialIndex >= 0) {
      selectList.setSelectedIndex(initialIndex);
    }

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          input.hint ??
            (input.searchable
              ? "Type to filter • enter to select • esc to cancel"
              : "↑↓ navigate • enter select • esc cancel"),
        ),
      ),
    );
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
};

const getKnownBranches = async (pi: ExtensionAPI): Promise<string[]> => {
  const { stdout, code } = await pi.exec("git", [
    "for-each-ref",
    "refs/heads",
    "refs/remotes",
    "--format=%(refname:short)",
  ]);
  if (code !== 0) {
    return [];
  }

  const seen = new Set<string>();
  return stdout
    .trim()
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => {
      if (!branch || branch === "HEAD" || branch.endsWith("/HEAD")) {
        return false;
      }
      if (seen.has(branch)) {
        return false;
      }
      seen.add(branch);
      return true;
    });
};

const getCurrentBranch = async (pi: ExtensionAPI): Promise<string | null> => {
  const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
  if (code !== 0 || !stdout.trim()) {
    return null;
  }
  return stdout.trim();
};

const getDefaultBranch = async (pi: ExtensionAPI): Promise<string | null> => {
  const { stdout, code } = await pi.exec("git", [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "--short",
  ]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim();
  }

  const branches = await getKnownBranches(pi);
  if (branches.includes("origin/main")) {
    return "origin/main";
  }
  if (branches.includes("origin/master")) {
    return "origin/master";
  }
  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }
  return branches[0] ?? null;
};

const scoreBranch = (branch: string, defaultBranch: string | null): number => {
  if (!defaultBranch) {
    return 2;
  }
  if (branch === defaultBranch) {
    return 0;
  }
  if (branch === defaultBranch.replace(/^origin\//, "")) {
    return 1;
  }
  return 2;
};

export const getDiffxReviewBranchSelectionState = async (
  pi: ExtensionAPI,
): Promise<{
  branches: string[];
  currentBranch: string | null;
  defaultBranch: string | null;
}> => {
  const [branches, currentBranch, defaultBranch] = await Promise.all([
    getKnownBranches(pi),
    getCurrentBranch(pi),
    getDefaultBranch(pi),
  ]);

  const candidates = currentBranch
    ? branches.filter((branch) => branch !== currentBranch)
    : branches;

  const sortedBranches = [...candidates].sort((left, right) => {
    const leftScore = scoreBranch(left, defaultBranch);
    const rightScore = scoreBranch(right, defaultBranch);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.localeCompare(right);
  });

  return {
    branches: sortedBranches,
    currentBranch,
    defaultBranch,
  };
};

const getRecentCommits = async (
  pi: ExtensionAPI,
  limit: number = COMMIT_SELECTION_LIMIT,
): Promise<GitCommitSummary[]> => {
  const { stdout, code } = await pi.exec("git", [
    "log",
    "--oneline",
    "-n",
    `${limit}`,
  ]);
  if (code !== 0) {
    return [];
  }

  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split(" ");
      return {
        sha,
        title: rest.join(" "),
      };
    });
};

const selectBranch = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  title: string,
): Promise<string | null> => {
  const { branches, defaultBranch } =
    await getDiffxReviewBranchSelectionState(pi);
  if (branches.length === 0) {
    ctx.ui.notify("No other branches available to compare", "warning");
    return null;
  }

  const items: SelectItem[] = branches.map((branch) => ({
    value: branch,
    label: branch,
    description: branch === defaultBranch ? "(default)" : "",
  }));

  return showSelectList({
    ctx,
    title,
    items,
    searchable: true,
    initialValue:
      defaultBranch && branches.includes(defaultBranch)
        ? defaultBranch
        : undefined,
  });
};

const selectCommit = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  title: string,
): Promise<GitCommitSummary | null> => {
  const commits = await getRecentCommits(pi);
  if (commits.length === 0) {
    ctx.ui.notify("No commits found", "warning");
    return null;
  }

  const items: SelectItem[] = commits.map((commit) => ({
    value: commit.sha,
    label: `${commit.sha.slice(0, 7)} ${commit.title}`,
    description: "",
  }));

  const selectedSha = await showSelectList({
    ctx,
    title,
    items,
    searchable: true,
  });
  if (!selectedSha) {
    return null;
  }

  return commits.find((commit) => commit.sha === selectedSha) ?? null;
};

const selectCustomDiffArgs = async (
  ctx: ExtensionCommandContext,
): Promise<string[] | null> => {
  const value = await ctx.ui.editor("Enter git diff args:", "main..HEAD");
  if (!value?.trim()) {
    return null;
  }
  return parseRawDiffArgs(value);
};

const resolvePresetDiffArgs = async (
  preset: DiffxComparePreset,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string[] | null> => {
  switch (preset) {
    case "working-tree":
      return [];
    case "staged":
      return ["--cached"];
    case "base-branch": {
      const branch = await selectBranch(pi, ctx, "Select base branch");
      return branch ? buildBaseBranchDiffArgs(branch) : null;
    }
    case "merge-base": {
      const branch = await selectBranch(pi, ctx, "Select merge-base branch");
      return branch ? buildMergeBaseDiffArgs(branch) : null;
    }
    case "single-commit": {
      const commit = await selectCommit(pi, ctx, "Select commit to review");
      return commit ? buildSingleCommitDiffArgs(commit.sha) : null;
    }
    case "two-commits": {
      const from = await selectCommit(pi, ctx, "Select starting commit");
      if (!from) {
        return null;
      }

      while (true) {
        const to = await selectCommit(
          pi,
          ctx,
          `Select ending commit (after ${from.sha.slice(0, 7)})`,
        );
        if (!to) {
          return null;
        }
        if (to.sha === from.sha) {
          ctx.ui.notify(
            "Select a different commit for the end of the range",
            "warning",
          );
          continue;
        }
        return buildCommitRangeDiffArgs(from.sha, to.sha);
      }

      return null;
    }
    case "custom":
      return selectCustomDiffArgs(ctx);
  }
};

export const promptForDiffxReviewDiffArgs = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string[] | null> => {
  const items: SelectItem[] = DIFFX_COMPARE_PRESET_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));

  const preset = await showSelectList({
    ctx,
    title: "Select diffx compare mode",
    items,
  });
  if (!preset) {
    return null;
  }

  return resolvePresetDiffArgs(preset as DiffxComparePreset, pi, ctx);
};
