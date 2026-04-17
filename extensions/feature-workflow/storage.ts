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

const recordPath = (repoRoot: string, id: string): string =>
  path.join(repoRoot, FEATURES_DIR, `${id}.json`);

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

export function listFeatureRecords(repoRoot: string): FeatureRecord[] {
  const dir = path.join(repoRoot, FEATURES_DIR);
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir);
  const records: FeatureRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const record = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as FeatureRecord;
      records.push(record);
    } catch {
      // ignore
    }
  }

  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records;
}
