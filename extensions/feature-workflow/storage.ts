import fs from "node:fs";
import path from "node:path";

import type { FeatureType } from "./naming.js";

export type FeatureStatus = "active";

export type FeatureRecord = {
  id: string;
  name: string;
  type: FeatureType;
  slug: string;
  branch: string;
  base: string;
  worktreePath: string;
  sessionPath?: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
};

const FEATURES_DIR = path.join(".pi", "features");
const FEATURE_BRANCH_PATTERN =
  /^(feat|fix|chore|spike)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const EPOCH_ISO = new Date(0).toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const recordPath = (repoRoot: string, id: string): string =>
  path.join(repoRoot, FEATURES_DIR, `${id}.json`);

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

export function writeFeatureRecord(
  repoRoot: string,
  record: FeatureRecord,
): void {
  fs.mkdirSync(path.dirname(recordPath(repoRoot, record.id)), {
    recursive: true,
  });
  fs.writeFileSync(
    recordPath(repoRoot, record.id),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export function readFeatureRecord(
  repoRoot: string,
  id: string,
): FeatureRecord | null {
  const filePath = recordPath(repoRoot, id);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as FeatureRecord;
  } catch {
    return null;
  }
}

export function listFeatureRecords(
  repoRoot: string,
  wtListJson: string,
): FeatureRecord[] {
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

    const matched = FEATURE_BRANCH_PATTERN.exec(branch);
    if (!matched) continue;

    const type = matched[1] as FeatureType;
    const slug = matched[2];
    const id = `${type}-${slug}`;
    const stored = readFeatureRecord(repoRoot, id);

    const wtUpdatedAt =
      toIsoFromWtCommitTimestamp(item.commit) ?? stored?.updatedAt ?? EPOCH_ISO;

    records.push({
      id,
      name: stored?.name ?? slug,
      type,
      slug,
      branch,
      base: stored?.base ?? "",
      worktreePath,
      sessionPath: stored?.sessionPath,
      status: "active",
      createdAt: stored?.createdAt ?? wtUpdatedAt,
      updatedAt: wtUpdatedAt,
    });
  }

  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records;
}
