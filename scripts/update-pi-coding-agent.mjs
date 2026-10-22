import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
const PI_RUNTIME_PACKAGES = [
  PI_AI_PACKAGE,
  PI_CODING_AGENT_PACKAGE,
  PI_TUI_PACKAGE,
];
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

const getNpmCommand = () => (process.platform === "win32" ? "npm.cmd" : "npm");

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const updatePeerDependencies = (packageJson, latestVersion) => {
  if (!isObject(packageJson)) {
    throw new Error("Root package.json must contain a JSON object.");
  }

  if (!isObject(packageJson.peerDependencies)) {
    throw new Error(
      "Root package.json must contain a peerDependencies object.",
    );
  }

  const targetRange = `^${latestVersion}`;
  const nextPiPeerDependencies = Object.fromEntries(
    PI_RUNTIME_PACKAGES.map((packageName) => [packageName, targetRange]),
  );

  return {
    ...packageJson,
    peerDependencies: {
      ...packageJson.peerDependencies,
      ...nextPiPeerDependencies,
    },
  };
};

export const piBinaryName = (platform = process.platform) =>
  platform === "win32" ? "pi.cmd" : "pi";

// `npm run` prepends node_modules/.bin to PATH, so a stale repo-local copy of
// pi would shadow the installed one and report the wrong version.
const isRepoLocalNodeModulesBin = (candidate) =>
  candidate.split(path.sep).includes("node_modules");

// Places to look for the pi launcher, in priority order. `pi` is installed
// three different ways on real machines (managed install under ~/.pi/agent/bin,
// a global npm prefix, or Homebrew), so the script must not hardcode one path.
export const listPiBinaryCandidates = (env = process.env) => {
  const binaryName = piBinaryName();
  const candidates = [];

  if (env.PI_MANAGED_INSTALL_ROOT) {
    candidates.push(path.join(env.PI_MANAGED_INSTALL_ROOT, "bin", binaryName));
  }

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, binaryName));
    }
  }

  return [...new Set(candidates)].filter(
    (candidate) => !isRepoLocalNodeModulesBin(candidate),
  );
};

export const resolvePiBinary = (env = process.env, exists = existsSync) => {
  if (env.PI_BIN) {
    return env.PI_BIN;
  }

  return (
    listPiBinaryCandidates(env).find((candidate) => exists(candidate)) ??
    piBinaryName()
  );
};

export const resolveNpmRegistry = (env = process.env) =>
  env.PI_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;

export const buildInstallArgs = (latestVersion, env = process.env) => {
  const targetRange = `^${latestVersion}`;
  const installArgs = PI_RUNTIME_PACKAGES.map(
    (packageName) => `${packageName}@${targetRange}`,
  );

  return [
    "install",
    ...installArgs,
    "--save-peer",
    `--registry=${resolveNpmRegistry(env)}`,
  ];
};

const readPackageJson = (packageJsonPath) =>
  JSON.parse(readFileSync(packageJsonPath, "utf8"));

const writePackageJson = (packageJsonPath, packageJson) => {
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
};

const getPiVersion = () => {
  const piBinary = resolvePiBinary();
  const result = spawnSync(piBinary, ["--version"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        `Could not run \`${piBinary} --version\`: binary not found. Install pi, add it to PATH, or set PI_BIN=/path/to/pi.`,
      );
    }

    throw result.error;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (result.status !== 0) {
    throw new Error(
      `pi --version failed with exit code ${result.status ?? "unknown"}: ${output || "<empty>"}`,
    );
  }

  const match = output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/);
  if (!match) {
    throw new Error(`Unexpected pi --version output: ${output || "<empty>"}`);
  }

  return match[0];
};

const runInstall = (latestVersion) => {
  const result = spawnSync(getNpmCommand(), buildInstallArgs(latestVersion), {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(
      `npm install failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
};

export const main = () => {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const currentPackageJson = readPackageJson(packageJsonPath);
  const previousRange =
    currentPackageJson.peerDependencies?.[PI_CODING_AGENT_PACKAGE] ??
    "<missing>";

  console.log("Reading current pi version via `pi --version`...");
  const latestVersion = getPiVersion();
  const targetRange = `^${latestVersion}`;

  console.log(`Updating package.json peerDependencies to ${targetRange}`);
  const nextPackageJson = updatePeerDependencies(
    currentPackageJson,
    latestVersion,
  );
  writePackageJson(packageJsonPath, nextPackageJson);

  console.log("Running npm install for pi-ai, pi-coding-agent, and pi-tui...");
  runInstall(latestVersion);

  console.log(
    `Updated pi peerDependencies from ${previousRange} to ${targetRange}`,
  );
  console.log(`Installed target version ${latestVersion}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
