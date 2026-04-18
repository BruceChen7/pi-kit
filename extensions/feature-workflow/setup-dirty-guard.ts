const FEATURE_SETUP_MANAGED_PATHS = new Set<string>([
  ".pi/third_extension_settings.json",
  ".gitignore",
  ".worktreeinclude",
  ".config/wt.toml",
]);

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\.\//, "");

export const isFeatureSetupManagedPath = (path: string): boolean =>
  FEATURE_SETUP_MANAGED_PATHS.has(normalizePath(path));

export const areOnlyFeatureSetupManagedDirtyPaths = (
  dirtyPaths: string[],
): boolean => {
  const normalized = dirtyPaths
    .map(normalizePath)
    .filter((path) => path.length > 0);
  if (normalized.length === 0) {
    return false;
  }

  return normalized.every((path) => FEATURE_SETUP_MANAGED_PATHS.has(path));
};
