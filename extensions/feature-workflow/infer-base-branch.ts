import type { GitRunner } from "../shared/git.js";

import { trimToNull } from "./utils.js";

export type InferredBaseBranchResult =
  | {
      kind: "resolved";
      branch: string;
      basis: "fork-point" | "merge-base";
      confidence: "high" | "medium" | "low";
    }
  | {
      kind: "ambiguous";
      candidates: string[];
    }
  | {
      kind: "unknown";
      reason: "detached-head" | "no-candidates" | "no-graph-signal";
    };

type InferenceBasis = "fork-point" | "merge-base";

type CandidateEvidence = {
  branch: string;
  basis: InferenceBasis;
  baseCommit: string;
  candidateDistance: number;
  featureDistance: number;
  tieBreakPriority: number;
};

const dedupe = (branches: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const branch of branches) {
    if (seen.has(branch)) continue;
    seen.add(branch);
    result.push(branch);
  }

  return result;
};

export const isInferredBaseCandidateBranch = (branch: string): boolean =>
  branch === "main" ||
  branch === "master" ||
  branch === "release" ||
  branch.startsWith("release/") ||
  branch.startsWith("release-");

export const filterInferredBaseCandidateBranches = (
  branches: string[],
): string[] =>
  dedupe(
    branches
      .map((branch) => trimToNull(branch))
      .filter((branch): branch is string => branch !== null)
      .filter(isInferredBaseCandidateBranch),
  );

const getTieBreakPriority = (branch: string): number => {
  if (branch === "main") return 0;
  if (branch === "master") return 1;
  return 2;
};

const getBasisPriority = (basis: InferenceBasis): number =>
  basis === "fork-point" ? 0 : 1;

const compareCandidateEvidence = (
  left: CandidateEvidence,
  right: CandidateEvidence,
): number => {
  const basisPriority =
    getBasisPriority(left.basis) - getBasisPriority(right.basis);
  if (basisPriority !== 0) return basisPriority;

  const candidateDistance = left.candidateDistance - right.candidateDistance;
  if (candidateDistance !== 0) return candidateDistance;

  const tieBreak = left.tieBreakPriority - right.tieBreakPriority;
  if (tieBreak !== 0) return tieBreak;

  const featureDistance = left.featureDistance - right.featureDistance;
  if (featureDistance !== 0) return featureDistance;

  return left.branch.localeCompare(right.branch);
};

const readCommit = (runGit: GitRunner, args: string[]): string | null => {
  const result = runGit(args);
  if (result.exitCode !== 0) return null;
  return trimToNull(result.stdout);
};

const readRevisionDistance = (
  runGit: GitRunner,
  fromCommit: string,
  toRef: string,
): number | null => {
  const result = runGit(["rev-list", "--count", `${fromCommit}..${toRef}`]);
  if (result.exitCode !== 0) return null;

  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildCandidateEvidence = (
  runGit: GitRunner,
  currentBranch: string,
  candidate: string,
): CandidateEvidence | null => {
  const forkPointCommit = readCommit(runGit, [
    "merge-base",
    "--fork-point",
    candidate,
    currentBranch,
  ]);
  const basis: InferenceBasis = forkPointCommit ? "fork-point" : "merge-base";
  const baseCommit =
    forkPointCommit ??
    readCommit(runGit, ["merge-base", candidate, currentBranch]);
  if (!baseCommit) {
    return null;
  }

  const candidateDistance = readRevisionDistance(runGit, baseCommit, candidate);
  const featureDistance = readRevisionDistance(
    runGit,
    baseCommit,
    currentBranch,
  );
  if (candidateDistance === null || featureDistance === null) {
    return null;
  }

  return {
    branch: candidate,
    basis,
    baseCommit,
    candidateDistance,
    featureDistance,
    tieBreakPriority: getTieBreakPriority(candidate),
  };
};

const isReleaseCandidate = (candidate: CandidateEvidence): boolean =>
  candidate.tieBreakPriority === 2;

const isIndistinguishableReleaseCandidate = (
  left: CandidateEvidence,
  right: CandidateEvidence,
): boolean =>
  isReleaseCandidate(left) &&
  isReleaseCandidate(right) &&
  left.basis === right.basis &&
  left.baseCommit === right.baseCommit &&
  left.candidateDistance === right.candidateDistance &&
  left.featureDistance === right.featureDistance;

const resolveConfidence = (
  winner: CandidateEvidence,
  runnerUp: CandidateEvidence | null,
): "high" | "medium" | "low" => {
  if (!runnerUp) {
    return winner.basis === "fork-point" ? "high" : "medium";
  }

  const strongerByBasis = winner.basis !== runnerUp.basis;
  const strongerByCandidateDistance =
    winner.candidateDistance !== runnerUp.candidateDistance;
  const strongerByFeatureDistance =
    winner.featureDistance !== runnerUp.featureDistance;
  const strongerOnlyByTieBreak =
    !strongerByBasis &&
    !strongerByCandidateDistance &&
    !strongerByFeatureDistance;

  if (winner.basis === "fork-point") {
    if (strongerByBasis || strongerByCandidateDistance) {
      return "high";
    }
    if (strongerOnlyByTieBreak) {
      return "low";
    }
    return "medium";
  }

  if (strongerByBasis || strongerByCandidateDistance) {
    return "medium";
  }

  return "low";
};

export function inferBaseBranch(input: {
  currentBranch: string | null;
  localBranches: string[];
  runGit: GitRunner;
}): InferredBaseBranchResult {
  const currentBranch = trimToNull(input.currentBranch);
  if (!currentBranch) {
    return { kind: "unknown", reason: "detached-head" };
  }

  const candidates = filterInferredBaseCandidateBranches(input.localBranches);
  if (candidates.length === 0) {
    return { kind: "unknown", reason: "no-candidates" };
  }

  const evidence = candidates
    .map((candidate) =>
      buildCandidateEvidence(input.runGit, currentBranch, candidate),
    )
    .filter((candidate): candidate is CandidateEvidence => candidate !== null)
    .sort(compareCandidateEvidence);

  if (evidence.length === 0) {
    return { kind: "unknown", reason: "no-graph-signal" };
  }

  const [winner, runnerUp] = evidence;
  if (!winner) {
    return { kind: "unknown", reason: "no-graph-signal" };
  }

  if (runnerUp && isIndistinguishableReleaseCandidate(winner, runnerUp)) {
    const ambiguousCandidates = evidence
      .filter((candidate) =>
        isIndistinguishableReleaseCandidate(winner, candidate),
      )
      .map((candidate) => candidate.branch)
      .sort((a, b) => a.localeCompare(b));

    return {
      kind: "ambiguous",
      candidates: dedupe(ambiguousCandidates),
    };
  }

  return {
    kind: "resolved",
    branch: winner.branch,
    basis: winner.basis,
    confidence: resolveConfidence(winner, runnerUp ?? null),
  };
}
