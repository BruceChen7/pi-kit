import { listFeatureRecordsFromWtList } from "./wt-list.js";

export type FeatureStatus = "active";

export type FeatureRecord = {
  slug: string;
  branch: string;
  worktreePath: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
};

export function listFeatureRecords(wtListJson: string): FeatureRecord[] {
  return listFeatureRecordsFromWtList(wtListJson);
}

export function hasActiveFeatureBranchConflict(
  records: FeatureRecord[],
  branch: string,
): boolean {
  return records.some((record) => record.branch === branch);
}
