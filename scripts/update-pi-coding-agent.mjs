import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PI_CODING_AGENT_PACKAGE = "@mariozechner/pi-coding-agent";
const PI_TUI_PACKAGE = "@mariozechner/pi-tui";

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

  return {
    ...packageJson,
    peerDependencies: {
      ...packageJson.peerDependencies,
      [PI_CODING_AGENT_PACKAGE]: targetRange,
      [PI_TUI_PACKAGE]: targetRange,
    },
  };
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

const getLatestPiCodingAgentVersion = () => {
  const output = execFileSync(
    getNpmCommand(),
    ["view", PI_CODING_AGENT_PACKAGE, "version"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  ).trim();

  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(output)) {
    throw new Error(`Unexpected npm version output: ${output || "<empty>"}`);
  }

  return output;
};

const runInstall = (latestVersion) => {
  const targetRange = `^${latestVersion}`;
  const result = spawnSync(
    getNpmCommand(),
    [
      "install",
      `${PI_CODING_AGENT_PACKAGE}@${targetRange}`,
      `${PI_TUI_PACKAGE}@${targetRange}`,
      "--save-peer",
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );

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

  console.log(`Resolving latest ${PI_CODING_AGENT_PACKAGE} version...`);
  const latestVersion = getLatestPiCodingAgentVersion();
  const targetRange = `^${latestVersion}`;

  console.log(`Updating package.json peerDependencies to ${targetRange}`);
  const nextPackageJson = updatePeerDependencies(
    currentPackageJson,
    latestVersion,
  );
  writePackageJson(packageJsonPath, nextPackageJson);

  console.log("Running npm install for pi-coding-agent and pi-tui...");
  runInstall(latestVersion);

  console.log(
    `Updated pi-coding-agent peerDependency from ${previousRange} to ${targetRange}`,
  );
  console.log(`Installed target version ${latestVersion}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
