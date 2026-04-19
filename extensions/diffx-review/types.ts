import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface DiffxCommentReply {
  id: string;
  body: string;
  createdAt: number;
}

export type DiffxComparePreset =
  | "working-tree"
  | "staged"
  | "base-branch"
  | "merge-base"
  | "single-commit"
  | "two-commits"
  | "custom";

export interface DiffxComparePresetOption {
  value: DiffxComparePreset;
  label: string;
  description: string;
}

export interface GitCommitSummary {
  sha: string;
  title: string;
}

export interface DiffxReviewComment {
  id: string;
  filePath: string;
  side: "deletions" | "additions";
  lineNumber: number;
  lineContent: string;
  body: string;
  status: "open" | "resolved";
  createdAt: number;
  replies: DiffxCommentReply[];
}

export interface DiffxCommentStats {
  total: number;
  open: number;
  resolved: number;
}

export interface DiffxReviewConfig {
  enabled: boolean;
  diffxCommand: string | null;
  diffxPath: string;
  host: string;
  defaultPort: number | null;
  autoOpen: boolean;
  startMode: "dist";
  reuseExistingSession: boolean;
  healthcheckTimeoutMs: number;
  startupTimeoutMs: number;
}

export interface DiffxReviewSession {
  repoRoot: string;
  host: string;
  port: number;
  url: string;
  pid: number;
  startedAt: number;
  diffArgs: string[];
  openInBrowser: boolean;
  cwdAtStart: string;
  startCommand: string;
  lastHealthcheckAt: number | null;
  lastHealthcheckOk: boolean | null;
}

export interface DiffxRuntimeSession extends DiffxReviewSession {
  child: ChildProcessWithoutNullStreams;
}

export interface StartDiffxReviewSessionInput {
  repoRoot: string;
  diffxCommand: string | null;
  diffxPath: string;
  host: string;
  port: number | null;
  openInBrowser: boolean;
  diffArgs: string[];
  startupTimeoutMs: number;
}

export interface StartReviewArgs {
  noOpen: boolean;
  host: string | null;
  port: number | null;
  diffArgs: string[];
}

export interface FinishReviewArgs {
  resolveAfterReply: boolean;
}
