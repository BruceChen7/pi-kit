import type { FeatureRecord } from "./storage.js";

export type FeatureSwitchCandidate = {
  kind: "worktree" | "remote";
  branch: string;
  displayLabel: string;
  fallbackWorktreePath: string;
  matchKeys: string[];
  remoteRef: string | null;
  record: FeatureRecord | null;
};

type MatchedFeatureRecordResult = {
  kind: "matched";
  record: FeatureRecord;
};

type MatchedFeatureSwitchCandidateResult = {
  kind: "matched";
  candidate: FeatureSwitchCandidate;
};

type NotFoundFeatureQueryResult = {
  kind: "not-found";
  value: string;
};

export type MatchFeatureRecordResult =
  | MatchedFeatureRecordResult
  | NotFoundFeatureQueryResult;

export type MatchFeatureSwitchCandidateResult =
  | MatchedFeatureSwitchCandidateResult
  | NotFoundFeatureQueryResult;

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const addMatchKey = (matchKeys: string[], value: string | null): void => {
  if (!value || matchKeys.includes(value)) {
    return;
  }

  matchKeys.push(value);
};

export function matchFeatureRecord(
  records: FeatureRecord[],
  query: string,
): MatchFeatureRecordResult {
  const value = query.trim();
  if (!value) {
    return { kind: "not-found", value };
  }

  const byBranch = records.find((record) => record.branch === value);
  if (byBranch) {
    return { kind: "matched", record: byBranch };
  }

  return { kind: "not-found", value };
}

export function buildFeatureSwitchCandidates(input: {
  records: FeatureRecord[];
  originBranches: string[];
}): FeatureSwitchCandidate[] {
  const candidates: FeatureSwitchCandidate[] = [];
  const candidatesByBranch = new Map<string, FeatureSwitchCandidate>();

  for (const record of input.records) {
    const branch = trimToNull(record.branch);
    if (!branch) {
      continue;
    }

    const candidate: FeatureSwitchCandidate = {
      kind: "worktree",
      branch,
      displayLabel: branch,
      fallbackWorktreePath: record.worktreePath,
      matchKeys: [branch],
      remoteRef: null,
      record,
    };

    candidates.push(candidate);
    candidatesByBranch.set(branch, candidate);
  }

  for (const originBranch of input.originBranches) {
    const branch = trimToNull(originBranch);
    if (!branch) {
      continue;
    }

    const remoteRef = `origin/${branch}`;
    const existingCandidate = candidatesByBranch.get(branch);
    if (existingCandidate) {
      addMatchKey(existingCandidate.matchKeys, remoteRef);
      if (existingCandidate.remoteRef === null) {
        existingCandidate.remoteRef = remoteRef;
      }
      continue;
    }

    const candidate: FeatureSwitchCandidate = {
      kind: "remote",
      branch,
      displayLabel: `${branch} (remote)`,
      fallbackWorktreePath: "",
      matchKeys: [branch, remoteRef],
      remoteRef,
      record: null,
    };

    candidates.push(candidate);
    candidatesByBranch.set(branch, candidate);
  }

  return candidates;
}

export function matchFeatureSwitchCandidate(
  candidates: FeatureSwitchCandidate[],
  query: string,
): MatchFeatureSwitchCandidateResult {
  const value = query.trim();
  if (!value) {
    return { kind: "not-found", value };
  }

  const candidate = candidates.find((item) => item.matchKeys.includes(value));
  if (candidate) {
    return { kind: "matched", candidate };
  }

  return { kind: "not-found", value };
}
