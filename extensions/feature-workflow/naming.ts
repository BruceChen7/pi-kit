const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isFeatureSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function buildFeatureBranchName(input: { slug: string }): string {
  return input.slug.trim();
}
