export type BaseBranchCandidatesInput = {
  currentBranch: string | null;
  localBranches: string[];
  inferredBaseBranch?: string | null;
};

const normalizeBranch = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
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
  const inferredBaseBranch = normalizeBranch(input.inferredBaseBranch ?? null);
  if (inferredBaseBranch && localSet.has(inferredBaseBranch)) {
    prioritized.push(inferredBaseBranch);
  }

  const current = input.currentBranch
    ? normalizeBranch(input.currentBranch)
    : null;
  if (current && localSet.has(current)) {
    prioritized.push(current);
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
