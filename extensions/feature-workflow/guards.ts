export type StatusOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BaseFreshnessResult = {
  ok: boolean;
  upstream: string | null;
  behind: number | null;
};

const toInt = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export function checkBaseBranchFreshness(input: {
  runGit: (args: string[]) => StatusOutput;
  baseBranch: string;
}): BaseFreshnessResult {
  const upstreamResult = input.runGit([
    "rev-parse",
    "--abbrev-ref",
    `${input.baseBranch}@{upstream}`,
  ]);

  const upstream =
    upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : "";
  if (!upstream) {
    return { ok: true, upstream: null, behind: null };
  }

  const counts = input.runGit([
    "rev-list",
    "--left-right",
    "--count",
    `${upstream}...${input.baseBranch}`,
  ]);

  const parts = counts.exitCode === 0 ? counts.stdout.trim().split(/\s+/) : [];
  const behind = toInt(parts[0]);

  if (counts.exitCode !== 0 || behind === null) {
    return { ok: false, upstream, behind: null };
  }

  return { ok: behind === 0, upstream, behind };
}
