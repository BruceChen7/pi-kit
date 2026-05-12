import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIBRARY_DIR, PLUGIN_LIBRARY_MANIFEST } from "./constants.ts";
import type {
  PluginEntry,
  PluginLibraryManifest,
  ThirdPartyInstallOptions,
  ThirdPartyInstallResult,
} from "./types.ts";
import { isRecord, statTargetOrNull, toStringList } from "./utils.ts";

interface ParsedNpmSource {
  kind: "npm";
  source: string;
  name: string;
  packageSpec: string;
}

interface ParsedGithubSource {
  kind: "github";
  source: string;
  name: string;
  repoUrl: string;
  ref?: string;
}

type ParsedThirdPartySource = ParsedNpmSource | ParsedGithubSource;

interface InstallCommandContext {
  source: ParsedThirdPartySource;
  targetPath: string;
  stage: string;
}

export function getDefaultPluginLibraryDir(): string {
  return DEFAULT_LIBRARY_DIR;
}

function manifestPath(libraryDir: string): string {
  return path.join(libraryDir, PLUGIN_LIBRARY_MANIFEST);
}

export function readPluginLibraryManifest(
  libraryDir = DEFAULT_LIBRARY_DIR,
): PluginLibraryManifest {
  try {
    const content = fs.readFileSync(manifestPath(libraryDir), "utf-8");
    const parsed = JSON.parse(content) as Partial<PluginLibraryManifest>;
    if (!isRecord(parsed.plugins)) return { plugins: {} };
    return {
      plugins: parsed.plugins as PluginLibraryManifest["plugins"],
    };
  } catch {
    return { plugins: {} };
  }
}

function writePluginLibraryManifest(
  libraryDir: string,
  manifest: PluginLibraryManifest,
): void {
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(
    manifestPath(libraryDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

function npmPluginName(packageSpec: string): string {
  return packageSpec.replace(/^@/, "").replaceAll("/", "-");
}

function parseGithubSource(source: string): ParsedGithubSource | null {
  const repo = source
    .replace(/^github:/, "https://github.com/")
    .replace(/^git:github\.com\//, "https://github.com/");
  if (!repo.startsWith("https://github.com/")) return null;

  const [repoUrl, ref] = repo.split("@");
  const match = repoUrl.match(
    /^https:\/\/github\.com\/[^/]+\/([^/]+?)(?:\.git)?$/,
  );
  if (!match) return null;

  return {
    kind: "github",
    source,
    name: match[1],
    repoUrl,
    ...(ref ? { ref } : {}),
  };
}

function parseThirdPartySource(source: string): ParsedThirdPartySource {
  if (source.startsWith("npm:")) {
    const packageSpec = source.replace(/^npm:/, "");
    if (!packageSpec)
      throw new Error("Unsupported plugin source: empty npm package");
    return {
      kind: "npm",
      source,
      name: npmPluginName(packageSpec),
      packageSpec,
    };
  }

  const githubSource = parseGithubSource(source);
  if (githubSource) return githubSource;

  throw new Error(
    `Unsupported plugin source: ${source}. Expected npm:, github:, git:github.com/, or https://github.com/`,
  );
}

function copyPluginSource(sourcePath: string, targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function execInstallCommand(
  command: string,
  args: string[],
  options: childProcess.ExecFileSyncOptions,
  context: InstallCommandContext,
): void {
  try {
    childProcess.execFileSync(command, args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to install plugin from ${context.source.source} during ${context.stage} into ${context.targetPath}: ${message}`,
      { cause: error },
    );
  }
}

function installNpmProductionDependencies(
  source: ParsedThirdPartySource,
  targetPath: string,
): void {
  execInstallCommand(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts"],
    { cwd: targetPath, stdio: "ignore" },
    { source, targetPath, stage: "npm install production dependencies" },
  );
}

function installNpmPackageSource(
  source: ParsedNpmSource,
  targetPath: string,
): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-npm-"));
  try {
    execInstallCommand(
      "npm",
      ["pack", source.packageSpec, "--pack-destination", tempDir],
      { stdio: "ignore" },
      { source, targetPath, stage: "npm pack" },
    );
    const tarball = fs
      .readdirSync(tempDir)
      .find((entry) => entry.endsWith(".tgz"));
    if (!tarball)
      throw new Error(`npm pack produced no tarball for ${source.source}`);
    execInstallCommand(
      "tar",
      ["-xzf", path.join(tempDir, tarball), "-C", tempDir],
      { stdio: "ignore" },
      { source, targetPath, stage: "extract npm package" },
    );
    copyPluginSource(path.join(tempDir, "package"), targetPath);
    installNpmProductionDependencies(source, targetPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function installGithubSource(
  source: ParsedGithubSource,
  targetPath: string,
): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (source.ref) args.push("--branch", source.ref);
  args.push(
    source.repoUrl.endsWith(".git") ? source.repoUrl : `${source.repoUrl}.git`,
    targetPath,
  );
  execInstallCommand(
    "git",
    args,
    { stdio: "ignore" },
    {
      source,
      targetPath,
      stage: "git clone",
    },
  );
}

function installThirdPartySource(
  parsedSource: ParsedThirdPartySource,
  installedPath: string,
  options: ThirdPartyInstallOptions,
): void {
  if (parsedSource.kind === "npm") {
    const packageRoot = options.npmPackageRoot;
    if (!packageRoot) {
      installNpmPackageSource(parsedSource, installedPath);
      return;
    }

    copyPluginSource(packageRoot, installedPath);
    installNpmProductionDependencies(parsedSource, installedPath);
    return;
  }

  const repoRoot = options.githubRepoRoot;
  if (repoRoot) {
    copyPluginSource(repoRoot, installedPath);
    return;
  }

  installGithubSource(parsedSource, installedPath);
}

export function installThirdPartyPluginToLibrary(
  source: string,
  options: ThirdPartyInstallOptions = {},
): ThirdPartyInstallResult {
  const libraryDir = options.libraryDir ?? DEFAULT_LIBRARY_DIR;
  const parsedSource = parseThirdPartySource(source);
  const installedPath = path.join(libraryDir, parsedSource.name);

  installThirdPartySource(parsedSource, installedPath, options);

  const manifest = readPluginLibraryManifest(libraryDir);
  manifest.plugins[parsedSource.name] = {
    kind: parsedSource.kind,
    source,
    installedPath,
  };
  writePluginLibraryManifest(libraryDir, manifest);
  return {
    name: parsedSource.name,
    sourceKind: parsedSource.kind,
    installedPath,
  };
}

function hasDeclaredPiExtensions(dir: string): boolean {
  try {
    const packageJson = fs.readFileSync(
      path.join(dir, "package.json"),
      "utf-8",
    );
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    if (!isRecord(parsed.pi)) return false;

    return toStringList(parsed.pi.extensions).some(
      (extensionPath) =>
        extensionPath.trim().length > 0 && !extensionPath.startsWith("!"),
    );
  } catch {
    return false;
  }
}

export function isPluginDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "index.ts")) || hasDeclaredPiExtensions(dir)
  );
}

export function isPluginFile(file: string): boolean {
  return file.endsWith(".ts") && path.basename(file) !== "index.ts";
}

export function discoverPlugins(
  libraryDir = DEFAULT_LIBRARY_DIR,
): PluginEntry[] {
  if (!fs.existsSync(libraryDir)) return [];

  const plugins: PluginEntry[] = [];
  for (const entryName of fs.readdirSync(libraryDir).sort()) {
    if (entryName.startsWith(".")) continue;
    const sourcePath = path.join(libraryDir, entryName);
    const stat = statTargetOrNull(sourcePath);
    if (!stat) continue;

    if (stat.isDirectory() && isPluginDir(sourcePath)) {
      plugins.push({
        name: entryName,
        enabledName: entryName,
        sourcePath,
        kind: "directory",
      });
      continue;
    }

    if (stat.isFile() && isPluginFile(sourcePath)) {
      const name = path.basename(entryName, ".ts");
      plugins.push({
        name,
        enabledName: entryName,
        sourcePath,
        kind: "file",
      });
    }
  }

  return plugins.sort((left, right) => left.name.localeCompare(right.name));
}
