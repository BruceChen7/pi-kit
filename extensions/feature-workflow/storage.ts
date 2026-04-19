import type { ManagedFeatureBranchRecord } from "./registry.js";

export type FeatureStatus = "active";

export type FeatureRecord = {
  name: string;
  slug: string;
  branch: string;
  worktreePath: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
};

const EPOCH_ISO = new Date(0).toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toIsoFromWtCommitTimestamp = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const timestamp = value.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }

  const millis = timestamp * 1000;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};

export function listFeatureRecords(
  wtListJson: string,
  managedBranches: Iterable<ManagedFeatureBranchRecord>,
): FeatureRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wtListJson) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const managedBranchMap = new Map(
    [...managedBranches].map((record) => [record.branch, record]),
  );
  if (managedBranchMap.size === 0) {
    return [];
  }

  const records: FeatureRecord[] = [];

  for (const item of parsed) {
    if (!isRecord(item)) continue;

    const branch = typeof item.branch === "string" ? item.branch : "";
    const worktreePath = typeof item.path === "string" ? item.path : "";
    const managedRecord = managedBranchMap.get(branch);
    if (!branch || !worktreePath || !managedRecord) continue;

    const wtUpdatedAt = toIsoFromWtCommitTimestamp(item.commit) ?? EPOCH_ISO;

    records.push({
      name: managedRecord.slug,
      slug: managedRecord.slug,
      branch,
      worktreePath,
      status: "active",
      createdAt: wtUpdatedAt,
      updatedAt: wtUpdatedAt,
    });
  }

  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records;
}

export function findActiveFeatureConflicts(
  records: FeatureRecord[],
  input: { branch: string; slug: string },
): { branchConflict: boolean; slugConflict: boolean } {
  return {
    branchConflict: records.some((record) => record.branch === input.branch),
    slugConflict: records.some((record) => record.slug === input.slug),
  };
}
