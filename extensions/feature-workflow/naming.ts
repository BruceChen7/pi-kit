const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FLAT_BRANCH_DELIMITER = "--";

export function isFeatureSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function buildFeatureBranchName(input: {
  base: string;
  slug: string;
}): string {
  const base = input.base.trim();
  return `${encodeURIComponent(base)}${FLAT_BRANCH_DELIMITER}${input.slug}`;
}

export function parseFeatureBranchName(branch: string): {
  base: string;
  slug: string;
} | null {
  const normalized = branch.trim();
  if (!normalized || normalized !== branch) return null;

  const flatDelimiterIndex = normalized.lastIndexOf(FLAT_BRANCH_DELIMITER);
  if (flatDelimiterIndex > 0) {
    const encodedBase = normalized.slice(0, flatDelimiterIndex);
    const slug = normalized.slice(
      flatDelimiterIndex + FLAT_BRANCH_DELIMITER.length,
    );
    if (!isFeatureSlug(slug)) return null;

    let decodedBase: string;
    try {
      decodedBase = decodeURIComponent(encodedBase);
    } catch {
      return null;
    }

    const base = decodedBase.trim();
    if (!base || base !== decodedBase) return null;
    if (encodeURIComponent(base) !== encodedBase) return null;

    return { base, slug };
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) return null;
  if (segments.some((segment) => segment !== segment.trim())) return null;
  const slug = segments.at(-1) ?? "";
  if (!isFeatureSlug(slug)) return null;

  if (segments.length < 2) return null;
  const baseSegments = segments.slice(0, -1);

  if (baseSegments.some((segment) => segment.length === 0)) return null;

  return {
    base: baseSegments.join("/"),
    slug,
  };
}
