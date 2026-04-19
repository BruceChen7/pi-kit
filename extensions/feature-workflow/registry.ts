import fs from "node:fs";
import path from "node:path";

import { isFeatureSlug, parseFeatureBranchName } from "./naming.js";

export type ManagedFeatureBranchRecord = {
  branch: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
};

const FEATURE_REGISTRY_RELATIVE_PATH = path.join(
  ".pi",
  "feature-workflow-branches.json",
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const trimToNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toManagedFeatureBranchRecord = (
  value: unknown,
): ManagedFeatureBranchRecord | null => {
  if (!isRecord(value)) return null;

  const branch = trimToNull(value.branch);
  const createdAt = trimToNull(value.createdAt);
  const updatedAt = trimToNull(value.updatedAt);
  if (!branch || !createdAt || !updatedAt) {
    return null;
  }

  const parsedLegacyBranch = parseFeatureBranchName(branch);
  const explicitSlug = trimToNull(value.slug);
  const slug =
    explicitSlug ??
    (isFeatureSlug(branch) ? branch : (parsedLegacyBranch?.slug ?? null));
  if (!slug || !isFeatureSlug(slug)) {
    return null;
  }

  if (isFeatureSlug(branch) && slug !== branch) {
    return null;
  }

  if (parsedLegacyBranch && slug !== parsedLegacyBranch.slug) {
    return null;
  }

  return {
    branch,
    slug,
    createdAt,
    updatedAt,
  };
};

const dedupeManagedFeatureBranchRecords = (
  records: ManagedFeatureBranchRecord[],
): ManagedFeatureBranchRecord[] => {
  const byBranch = new Map<string, ManagedFeatureBranchRecord>();

  for (const record of records) {
    const existing = byBranch.get(record.branch);
    if (!existing || existing.updatedAt.localeCompare(record.updatedAt) < 0) {
      byBranch.set(record.branch, record);
    }
  }

  return [...byBranch.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
};

export function getManagedFeatureRegistryPath(repoRoot: string): string {
  return path.join(repoRoot, FEATURE_REGISTRY_RELATIVE_PATH);
}

export function readManagedFeatureRegistry(
  repoRoot: string,
): ManagedFeatureBranchRecord[] {
  const registryPath = getManagedFeatureRegistryPath(repoRoot);
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return dedupeManagedFeatureBranchRecords(
    parsed
      .map((item) => toManagedFeatureBranchRecord(item))
      .filter((item): item is ManagedFeatureBranchRecord => item !== null),
  );
}

export function writeManagedFeatureRegistry(
  repoRoot: string,
  records: ManagedFeatureBranchRecord[],
): void {
  const registryPath = getManagedFeatureRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify(dedupeManagedFeatureBranchRecords(records), null, 2)}\n`,
    "utf-8",
  );
}

export function upsertManagedFeatureBranch(
  repoRoot: string,
  input: {
    branch: string;
    slug: string;
    timestamp?: string;
  },
): ManagedFeatureBranchRecord {
  const timestamp = trimToNull(input.timestamp) ?? new Date().toISOString();
  const existing = readManagedFeatureRegistry(repoRoot);
  const match = existing.find((record) => record.branch === input.branch);

  const nextRecord: ManagedFeatureBranchRecord = match
    ? {
        ...match,
        slug: input.slug,
        updatedAt: timestamp,
      }
    : {
        branch: input.branch,
        slug: input.slug,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

  const remaining = existing.filter((record) => record.branch !== input.branch);
  writeManagedFeatureRegistry(repoRoot, [...remaining, nextRecord]);
  return nextRecord;
}
