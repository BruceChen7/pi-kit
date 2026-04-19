const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isFeatureSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function buildFeatureBranchName(input: {
  base: string;
  slug: string;
}): string {
  const base = input.base.trim();
  return `${base}/${input.slug}`;
}

export function parseFeatureBranchName(branch: string): {
  base: string;
  slug: string;
} | null {
  const normalized = branch.trim();
  if (!normalized || normalized !== branch) return null;

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) return null;
  if (segments.some((segment) => segment !== segment.trim())) return null;
  if (segments.length < 2) return null;

  const slug = segments.at(-1) ?? "";
  if (!isFeatureSlug(slug)) return null;

  const baseSegments = segments.slice(0, -1);
  if (baseSegments.some((segment) => segment.length === 0)) return null;

  return {
    base: baseSegments.join("/"),
    slug,
  };
}
