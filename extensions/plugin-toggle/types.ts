export interface PluginEntry {
  name: string;
  enabledName: string;
  sourcePath: string;
  kind: "directory" | "file";
}

export type ThirdPartySourceKind = "npm" | "github";

export interface PluginLibraryManifestEntry {
  kind: ThirdPartySourceKind;
  source: string;
  installedPath: string;
}

export interface PluginLibraryManifest {
  plugins: Record<string, PluginLibraryManifestEntry>;
}

export interface ThirdPartyInstallOptions {
  libraryDir?: string;
  npmPackageRoot?: string;
  githubRepoRoot?: string;
}

export interface ThirdPartyInstallResult {
  name: string;
  sourceKind: ThirdPartySourceKind;
  installedPath: string;
}

export interface DefaultBootstrapResult {
  status: "bootstrapped" | "already-configured";
  enabled: string[];
  skippedDefaultDisabled: string[];
  conflicts: string[];
  /** Symlinks removed because the plugin is not in the effective enabled set. */
  removed: string[];
}

export type ToggleResult =
  | { status: "enabled" | "disabled" | "already-enabled" | "already-disabled" }
  | { status: "conflict"; path: string };
