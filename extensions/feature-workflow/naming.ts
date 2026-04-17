export type FeatureType = "feat" | "fix" | "chore" | "spike";

const collapseDashes = (value: string): string =>
  value.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");

export function slugifyFeatureName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const dashed = normalized.replace(/[^a-z0-9]+/g, "-");
  return collapseDashes(dashed);
}

export function buildFeatureBranchName(input: {
  type: FeatureType;
  slug: string;
}): string {
  return `${input.type}/${input.slug}`;
}

export function buildFeatureId(input: {
  type: FeatureType;
  slug: string;
}): string {
  return `${input.type}-${input.slug}`;
}
