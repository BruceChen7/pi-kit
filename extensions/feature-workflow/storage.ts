import {
  buildFeatureId,
  type FeatureType,
  parseFeatureBranchName,
} from "./naming.js";

export type FeatureStatus = "active";

export type FeatureRecord = {
  id: string;
  name: string;
  type: FeatureType;
  slug: string;
  branch: string;
  base: string;
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

export function listFeatureRecords(wtListJson: string): FeatureRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wtListJson) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const records: FeatureRecord[] = [];

  for (const item of parsed) {
    if (!isRecord(item)) continue;

    const branch = typeof item.branch === "string" ? item.branch : "";
    const worktreePath = typeof item.path === "string" ? item.path : "";
    if (!branch || !worktreePath) continue;

    const parsedBranch = parseFeatureBranchName(branch);
    if (!parsedBranch) continue;

    const type = parsedBranch.type;
    const slug = parsedBranch.slug;
    const id = buildFeatureId({
      type,
      base: parsedBranch.base,
      slug,
    });

    const wtUpdatedAt = toIsoFromWtCommitTimestamp(item.commit) ?? EPOCH_ISO;

    records.push({
      id,
      name: slug,
      type,
      slug,
      branch,
      base: parsedBranch.base,
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
  input: { id: string; branch: string },
): { idConflict: boolean; branchConflict: boolean } {
  return {
    idConflict: records.some((record) => record.id === input.id),
    branchConflict: records.some((record) => record.branch === input.branch),
  };
}
