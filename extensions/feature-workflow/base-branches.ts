import { parseFeatureBranchName } from "./naming.js";

export type BaseBranchCandidatesInput = {
  currentBranch: string | null;
  localBranches: string[];
  managedFeatureBranches?: Iterable<string>;
};

const normalizeBranch = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

const isReleaseBranch = (branch: string): boolean =>
  branch === "release" ||
  branch.startsWith("release/") ||
  branch.startsWith("release-");

const resolveCurrentBranchCandidate = (
  currentBranch: string,
  managedFeatureBranchSet: Set<string>,
): string | null => {
  if (!managedFeatureBranchSet.has(currentBranch)) {
    return currentBranch;
  }

  const parsed = parseFeatureBranchName(currentBranch);
  return parsed ? normalizeBranch(parsed.base) : currentBranch;
};

export function buildBaseBranchCandidates(
  input: BaseBranchCandidatesInput,
): string[] {
  const local = dedupe(
    input.localBranches
      .map((b) => normalizeBranch(b))
      .filter((b): b is string => b !== null),
  );

  const prioritized: string[] = [];
  const localSet = new Set(local);
  const managedFeatureBranchSet = new Set(input.managedFeatureBranches ?? []);
  const current = input.currentBranch
    ? normalizeBranch(input.currentBranch)
    : null;
  if (current) {
    const currentCandidate = resolveCurrentBranchCandidate(
      current,
      managedFeatureBranchSet,
    );
    if (currentCandidate && localSet.has(currentCandidate)) {
      prioritized.push(currentCandidate);
    }
  }

  for (const branch of ["main", "master"]) {
    if (local.includes(branch)) prioritized.push(branch);
  }

  const releaseBranches = local
    .filter(isReleaseBranch)
    .sort((a, b) => a.localeCompare(b));
  prioritized.push(...releaseBranches);

  const prioritizedSet = new Set(prioritized);
  const remaining = local
    .filter((b) => !prioritizedSet.has(b))
    .sort((a, b) => a.localeCompare(b));

  return dedupe([...prioritized, ...remaining]);
}
