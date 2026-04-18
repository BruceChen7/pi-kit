export type FeatureType = "feat" | "fix" | "chore" | "spike";

const FEATURE_TYPE_SET = new Set<FeatureType>([
  "feat",
  "fix",
  "chore",
  "spike",
]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const collapseDashes = (value: string): string =>
  value.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");

export function slugifyFeatureName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const dashed = normalized.replace(/[^a-z0-9]+/g, "-");
  return collapseDashes(dashed);
}

export function buildFeatureBranchName(input: {
  type: FeatureType;
  base: string;
  slug: string;
}): string {
  const base = input.base.trim();
  return `${input.type}/${base}/${input.slug}`;
}

export function parseFeatureBranchName(branch: string): {
  type: FeatureType;
  base: string;
  slug: string;
} | null {
  const normalized = branch.trim();
  if (!normalized || normalized !== branch) return null;

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) return null;
  if (segments.some((segment) => segment !== segment.trim())) return null;
  if (segments.length < 3) return null;

  const type = segments[0] as FeatureType;
  if (!FEATURE_TYPE_SET.has(type)) return null;

  const slug = segments.at(-1) ?? "";
  if (!SLUG_PATTERN.test(slug)) return null;

  const baseSegments = segments.slice(1, -1);
  if (baseSegments.some((segment) => segment.length === 0)) return null;

  return {
    type,
    base: baseSegments.join("/"),
    slug,
  };
}

const normalizeBaseForId = (base: string): string => {
  const normalized = base.trim().toLowerCase();
  const dashed = normalized.replace(/[^a-z0-9]+/g, "-");
  return collapseDashes(dashed);
};

export function buildFeatureId(input: {
  type: FeatureType;
  base: string;
  slug: string;
}): string {
  const baseForId = normalizeBaseForId(input.base);
  return baseForId
    ? `${input.type}-${baseForId}-${input.slug}`
    : `${input.type}-${input.slug}`;
}
