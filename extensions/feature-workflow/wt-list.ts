import type { FeatureRecord } from "./storage.js";

import { isRecord, trimToNull } from "./utils.ts";

export type WorktreePruneCandidate = {
  branch: string;
  path: string;
  mainState: string;
};

type WtListEntry = Record<string, unknown>;

const PRUNE_ELIGIBLE_MAIN_STATES = new Set(["integrated", "empty"]);
const EPOCH_ISO = new Date(0).toISOString();

function parseWtListJson(wtListJson: string): WtListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wtListJson) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(isRecord);
}

function toIsoFromWtCommitTimestamp(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const timestamp = value.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }

  const parsed = new Date(timestamp * 1000);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function readEntryString(entry: WtListEntry, key: string): string | null {
  const value = entry[key];
  return trimToNull(typeof value === "string" ? value : null);
}

function toFeatureRecord(entry: WtListEntry): FeatureRecord | null {
  const branch = readEntryString(entry, "branch");
  const worktreePath = readEntryString(entry, "path");
  if (!branch || !worktreePath) {
    return null;
  }

  const updatedAt = toIsoFromWtCommitTimestamp(entry.commit) ?? EPOCH_ISO;
  return {
    slug: branch,
    branch,
    worktreePath,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
  };
}

function sortFeatureRecords(records: FeatureRecord[]): FeatureRecord[] {
  return [...records].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function listFeatureRecordsFromWtList(
  wtListJson: string,
): FeatureRecord[] {
  const records = parseWtListJson(wtListJson)
    .map((entry) => toFeatureRecord(entry))
    .filter((record): record is FeatureRecord => record !== null);

  return sortFeatureRecords(records);
}

export function listSwitchableFeatureRecordsFromWtList(
  wtListJson: string,
): FeatureRecord[] {
  const records = parseWtListJson(wtListJson)
    .filter((entry) => entry.is_main !== true)
    .map((entry) => toFeatureRecord(entry))
    .filter((record): record is FeatureRecord => record !== null);

  return sortFeatureRecords(records);
}

function toPruneCandidate(entry: WtListEntry): WorktreePruneCandidate | null {
  if (entry.is_main === true) return null;

  const branch = readEntryString(entry, "branch");
  const path = readEntryString(entry, "path");
  const mainState = readEntryString(entry, "main_state");
  if (!branch || !path || !mainState) return null;
  if (!PRUNE_ELIGIBLE_MAIN_STATES.has(mainState)) return null;

  return {
    branch,
    path,
    mainState,
  };
}

export function listPruneCandidatesFromWtList(
  wtListJson: string,
): WorktreePruneCandidate[] {
  return parseWtListJson(wtListJson)
    .map((entry) => toPruneCandidate(entry))
    .filter(
      (candidate): candidate is WorktreePruneCandidate => candidate !== null,
    );
}

export function resolvePrimaryWorktreePathFromWtList(
  wtListJson: string,
): string | null {
  for (const entry of parseWtListJson(wtListJson)) {
    if (entry.is_main !== true) {
      continue;
    }

    const path = readEntryString(entry, "path");
    if (path) {
      return path;
    }
  }

  return null;
}

export function resolveWorktreePathForBranchFromWtList(
  wtListJson: string,
  branch: string,
): string | null {
  const normalizedBranch = trimToNull(branch);
  if (!normalizedBranch) {
    return null;
  }

  for (const entry of parseWtListJson(wtListJson)) {
    if (entry.branch !== normalizedBranch) {
      continue;
    }

    const path = readEntryString(entry, "path");
    if (path) {
      return path;
    }
  }

  return null;
}
