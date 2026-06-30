import { basename } from "node:path";

import type { SelectItem } from "@earendil-works/pi-tui";

export const CR_TMUX_WINDOW_NAME_PREFIX = "pi-cr";
export const CR_WIDGET_KEY = "cr-diffview";
export const START_COMMAND = "cr-neovim-start";
export const STOP_COMMAND = "cr-neovim-stop";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type CrMultiplexerType = "tmux" | "herdr";

export type CrReviewView = {
  /**
   * Domain identifier for the terminal view that hosts CR Neovim.
   * tmux: window name, herdr: tab ID.
   */
  reviewViewId: string;
  /**
   * Domain identifier for the terminal view to focus after review completion.
   * tmux: source pane ID, herdr: source tab ID.
   */
  originViewId: string;
};

export type CrReviewViewLaunch = {
  cwd: string;
  env: Record<string, string>;
  command: string;
  shellCommand: string;
};

export type OpenReviewViewResult = CrReviewView & ExecResult;

export type CrMultiplexer = {
  readonly type: CrMultiplexerType;
  readonly label: string;
  isAvailable(): boolean;
  openReviewView(
    reviewViewName: string,
    launch: CrReviewViewLaunch,
  ): Promise<OpenReviewViewResult>;
  closeReviewView(reviewViewId: string): Promise<ExecResult>;
  focusView(viewId: string): Promise<ExecResult>;
};

export const CR_PRESETS = [
  {
    value: "unstaged",
    label: "Review unstaged changes",
    description: "git diff",
  },
  {
    value: "staged",
    label: "Review staged changes",
    description: "git diff --cached",
  },
  {
    value: "lastNCommits",
    label: "Review last N commits",
    description: "HEAD~N...HEAD",
  },
  {
    value: "baseBranch",
    label: "Review against a base branch",
    description: "branch...HEAD",
  },
] as const;

export type CrPresetValue = (typeof CR_PRESETS)[number]["value"];

export type CrDiffScope = {
  target: string;
  label: string;
  diffArgs: string[];
};

export type CrSession = {
  sessionId: string;
  repoRoot: string;
  target: string;
  label: string;
  head: string;
  mergeBase: string;
  diffArgs: string[];
  socketPath: string;
  crSocketPath: string;
  reviewViewId: string;
  originViewId: string;
  artifactPath: string;
  createdAt: string;
};

export type CrAnnotation = {
  file: string;
  line: number;
  side?: string;
  snippet?: string;
  comment: string;
};

export type CrSocketPayload = {
  type?: string;
  annotations?: unknown[];
};

export type ScopeResolutionDecision =
  | { kind: "scope"; scope: CrDiffScope }
  | { kind: "needsInteractivePreset" }
  | { kind: "requiresInteractiveMode" };

export type PresetScopeDecision =
  | { kind: "scope"; scope: CrDiffScope }
  | { kind: "needsBranchSelection" }
  | { kind: "needsNumberInput" }
  | { kind: "cancelled" };

export const branchScope = (target: string): CrDiffScope => ({
  target,
  label: `${target}...HEAD`,
  diffArgs: [`${target}...HEAD`],
});

export const decideScopeResolution = (
  rawArgs: string,
  hasUI: boolean,
): ScopeResolutionDecision => {
  const target = rawArgs.trim();
  if (target) return { kind: "scope", scope: branchScope(target) };
  return hasUI
    ? { kind: "needsInteractivePreset" }
    : { kind: "requiresInteractiveMode" };
};

export const decideScopeFromPreset = (
  preset: CrPresetValue | null,
): PresetScopeDecision => {
  if (preset === "staged") {
    return {
      kind: "scope",
      scope: { target: "", label: "staged changes", diffArgs: ["--cached"] },
    };
  }

  if (preset === "unstaged") {
    return {
      kind: "scope",
      scope: { target: "", label: "unstaged changes", diffArgs: [] },
    };
  }

  if (preset === "lastNCommits") return { kind: "needsNumberInput" };
  if (preset === "baseBranch") return { kind: "needsBranchSelection" };
  return { kind: "cancelled" };
};

export const getBranchCandidates = (
  branches: string[],
  currentBranch: string | null,
): string[] =>
  currentBranch
    ? branches.filter((branch) => branch !== currentBranch)
    : branches;

export const buildBranchItems = (
  branches: string[],
  defaultBranch: string,
): SelectItem[] =>
  [...branches]
    .sort((left, right) => {
      if (left === defaultBranch) return -1;
      if (right === defaultBranch) return 1;
      return left.localeCompare(right);
    })
    .map((branch) => ({
      value: branch,
      label: branch,
      description: branch === defaultBranch ? "(default)" : "",
    }));

export const buildNoBranchCandidatesMessage = (
  currentBranch: string | null,
): string =>
  currentBranch
    ? `No other branches found (current branch: ${currentBranch})`
    : "No branches found";

export const buildCrReviewViewName = (repoRoot: string): string =>
  `${CR_TMUX_WINDOW_NAME_PREFIX}-${basename(repoRoot)}`;

export const buildCrTmuxWindowName = buildCrReviewViewName;

export const getCrReviewViewId = (session: CrSession | null): string =>
  session?.reviewViewId ?? CR_TMUX_WINDOW_NAME_PREFIX;

export const buildCrTmuxNewWindowArgs = <CommandArg = string>(
  tmuxWindowName: string,
  command: CommandArg,
): Array<string | CommandArg> => [
  "new-window",
  "-a",
  "-n",
  tmuxWindowName,
  command,
];

export const buildCrTmuxKillWindowArgs = (tmuxWindowName: string): string[] => [
  "kill-window",
  "-t",
  tmuxWindowName,
];

export const buildCrTmuxSelectPaneArgs = (tmuxPane: string): string[] => [
  "select-pane",
  "-t",
  tmuxPane,
];

export const isCrAnnotation = (value: unknown): value is CrAnnotation => {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as Partial<CrAnnotation>;
  return (
    typeof annotation.file === "string" &&
    typeof annotation.line === "number" &&
    Number.isFinite(annotation.line) &&
    typeof annotation.comment === "string" &&
    annotation.comment.trim().length > 0
  );
};

export const parseSocketPayload = (line: string): CrSocketPayload | null => {
  try {
    return JSON.parse(line) as CrSocketPayload;
  } catch {
    return null;
  }
};

export const annotationsFromFinishPayload = (
  payload: CrSocketPayload,
): CrAnnotation[] => {
  if (payload.type !== "finish" || !Array.isArray(payload.annotations)) {
    return [];
  }
  return payload.annotations.filter(isCrAnnotation);
};

export const parseAnnotationsJsonl = (raw: string): CrAnnotation[] => {
  try {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CrAnnotation)
      .filter((annotation) => annotation.comment?.trim());
  } catch {
    return [];
  }
};

export const formatAnnotationsPrompt = (
  annotations: CrAnnotation[],
): string => {
  const lines = [
    "I annotated the code review diff in Neovim.",
    "Please analyze these comments and propose or apply fixes as appropriate.",
    "",
  ];

  annotations.forEach((annotation, index) => {
    lines.push(`## CR annotation ${index + 1}`);
    lines.push(`- File: ${annotation.file}`);
    lines.push(`- Line: ${annotation.line}`);
    if (annotation.side) lines.push(`- Side: ${annotation.side}`);
    if (annotation.snippet) lines.push(`- Snippet: ${annotation.snippet}`);
    lines.push("- Comment:");
    lines.push(annotation.comment);
    lines.push("");
  });

  return lines.join("\n");
};
