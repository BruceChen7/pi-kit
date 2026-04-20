import type { FeatureRecord } from "./storage.js";

type MatchedFeatureRecordResult = {
  kind: "matched";
  record: FeatureRecord;
};

type NotFoundFeatureRecordResult = {
  kind: "not-found";
  value: string;
};

export type MatchFeatureRecordResult =
  | MatchedFeatureRecordResult
  | NotFoundFeatureRecordResult;

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
