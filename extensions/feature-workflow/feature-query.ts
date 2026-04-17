import type { FeatureRecord } from "./storage.js";

type MatchedFeatureRecordResult = {
  kind: "matched";
  record: FeatureRecord;
};

type NotFoundFeatureRecordResult = {
  kind: "not-found";
  value: string;
};

type AmbiguousFeatureRecordResult = {
  kind: "ambiguous-id" | "ambiguous-slug";
  value: string;
  branches: string[];
};

export type MatchFeatureRecordResult =
  | MatchedFeatureRecordResult
  | NotFoundFeatureRecordResult
  | AmbiguousFeatureRecordResult;

const toBranches = (records: FeatureRecord[]): string[] =>
  records.map((record) => record.branch);

const matchSingle = (
  records: FeatureRecord[],
): MatchedFeatureRecordResult | null => {
  if (records.length !== 1) return null;
  const [record] = records;
  return record ? { kind: "matched", record } : null;
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

  const byId = records.filter((record) => record.id === value);
  const uniqueIdMatch = matchSingle(byId);
  if (uniqueIdMatch) {
    return uniqueIdMatch;
  }
  if (byId.length > 1) {
    return {
      kind: "ambiguous-id",
      value,
      branches: toBranches(byId),
    };
  }

  const bySlug = records.filter((record) => record.slug === value);
  const uniqueSlugMatch = matchSingle(bySlug);
  if (uniqueSlugMatch) {
    return uniqueSlugMatch;
  }
  if (bySlug.length > 1) {
    return {
      kind: "ambiguous-slug",
      value,
      branches: toBranches(bySlug),
    };
  }

  return { kind: "not-found", value };
}
