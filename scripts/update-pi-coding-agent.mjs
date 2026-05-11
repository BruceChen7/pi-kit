import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
const DEFAULT_GLOBAL_PI_BIN = "/opt/homebrew/bin/pi";

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

export const resolvePiBinary = (env = process.env) =>
  env.PI_BIN || DEFAULT_GLOBAL_PI_BIN;

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
  const result = spawnSync(resolvePiBinary(), ["--version"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
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

  console.log("Reading current pi version via `pi --version`...");
  const latestVersion = getPiVersion();
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
