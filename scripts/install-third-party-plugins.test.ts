import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const libPath = path.join(
  repoRoot,
  "scripts",
  "install-third-party-plugins-lib.sh",
);
const installerPath = path.join(repoRoot, "install-third-party-plugins.sh");

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-install-third-party-plugins-"),
  );
  tempDirs.push(dir);
  return dir;
};

const runBash = (script: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync("bash", ["-lc", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  }).trim();

const bashString = (value: string): string => JSON.stringify(value);

const runIsInstalled = (
  source: string,
  settingsPath: string,
  env: NodeJS.ProcessEnv = {},
): string =>
  runBash(
    `source ${bashString(libPath)}; if is_installed ${bashString(source)} ${bashString(settingsPath)}; then echo yes; else echo no; fi`,
    env,
  );

const writeSettings = (filePath: string, packages: string[]): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ packages }, null, 2)}\n`,
    "utf8",
  );
};

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
};

const createFakeInstallTools = (binDir: string): void => {
  fs.mkdirSync(binDir, { recursive: true });

  const npmScript = `#!/bin/sh
set -eu
if [ "\${1:-}" = "install" ]; then
  mkdir -p node_modules
  echo installed > node_modules/.prod-deps-installed
  exit 0
fi

dest=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--pack-destination" ]; then dest="$arg"; fi
  prev="$arg"
done

mkdir -p "$dest/package"
echo 'export default function() {}' > "$dest/package/index.ts"
echo '{"dependencies":{"left-pad":"1.0.0"}}' > "$dest/package/package.json"
tar -czf "$dest/fake.tgz" -C "$dest" package
`;

  const gitScript = `#!/bin/sh
set -eu
target=""
for arg in "$@"; do target="$arg"; done

name="$(basename "$target")"
mkdir -p "$target/extensions/$name"
echo '{"pi":{"extensions":["./extensions"]}}' > "$target/package.json"
echo 'export default function() {}' > "$target/extensions/$name/index.ts"
`;

  writeExecutable(path.join(binDir, "npm"), npmScript);
  writeExecutable(path.join(binDir, "git"), gitScript);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("normalize_plugin_source", () => {
  it("converts GitHub shorthand to Pi git shorthand", () => {
    const result = runBash(
      `source ${bashString(libPath)}; normalize_plugin_source ${bashString("github:owner/repo")}`,
    );

    expect(result).toBe("git:github.com/owner/repo");
  });

  it("preserves GitHub shorthand refs using @ref syntax", () => {
    const result = runBash(
      `source ${bashString(libPath)}; normalize_plugin_source ${bashString("github:owner/repo@v1.2.3")}`,
    );

    expect(result).toBe("git:github.com/owner/repo@v1.2.3");
  });
});

describe("get_equivalent_sources", () => {
  it("returns GitHub source variants for an unpinned repo", () => {
    const result = runBash(
      `source ${bashString(libPath)}; get_equivalent_sources ${bashString("github:owner/repo")}`,
    );

    expect(result.split("\n")).toEqual([
      "github:owner/repo",
      "git:github.com/owner/repo",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
    ]);
  });

  it("returns only same-ref GitHub variants for a pinned repo", () => {
    const result = runBash(
      `source ${bashString(libPath)}; get_equivalent_sources ${bashString("https://github.com/owner/repo.git@v1.2.3")}`,
    );

    expect(result.split("\n")).toEqual([
      "github:owner/repo@v1.2.3",
      "git:github.com/owner/repo@v1.2.3",
      "https://github.com/owner/repo@v1.2.3",
      "https://github.com/owner/repo.git@v1.2.3",
    ]);
  });
});

describe("is_installed", () => {
  it("matches npm packages from settings.json", () => {
    const tempDir = createTempDir();
    const settingsPath = path.join(tempDir, "settings.json");
    writeSettings(settingsPath, ["npm:@plannotator/pi-extension"]);

    const result = runIsInstalled(
      "npm:@plannotator/pi-extension",
      settingsPath,
    );

    expect(result).toBe("yes");
  });

  it("does not invoke PATH-shadowed python3 while reading settings", () => {
    const tempDir = createTempDir();
    const binDir = path.join(tempDir, "bin");
    const settingsPath = path.join(tempDir, "settings.json");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "python3"),
      "#!/bin/sh\necho python3 should not run >&2\nexit 99\n",
      "utf8",
    );
    fs.chmodSync(path.join(binDir, "python3"), 0o755);
    writeSettings(settingsPath, ["npm:@plannotator/pi-extension"]);

    const result = runIsInstalled(
      "npm:@plannotator/pi-extension",
      settingsPath,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    );

    expect(result).toBe("yes");
  });

  it("matches equivalent GitHub repo forms in settings.json", () => {
    const tempDir = createTempDir();
    const settingsPath = path.join(tempDir, "settings.json");
    writeSettings(settingsPath, ["https://github.com/owner/repo.git"]);

    const result = runIsInstalled("github:owner/repo", settingsPath);

    expect(result).toBe("yes");
  });

  it("does not treat pinned and unpinned GitHub repos as equivalent", () => {
    const tempDir = createTempDir();
    const settingsPath = path.join(tempDir, "settings.json");
    writeSettings(settingsPath, ["git:github.com/owner/repo"]);

    const result = runIsInstalled("github:owner/repo@v1.2.3", settingsPath);

    expect(result).toBe("no");
  });
});

describe("install-third-party-plugins.sh", () => {
  it("installs third-party plugins into the shared plugin library manifest", () => {
    const home = createTempDir();
    const project = createTempDir();
    const binDir = path.join(createTempDir(), "bin");
    const logPath = path.join(createTempDir(), "pi.log");
    createFakeInstallTools(binDir);

    execFileSync("bash", [installerPath], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    const library = path.join(home, ".agents", "pi-plugins");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(library, ".manifest.json"), "utf8"),
    );
    expect(Object.keys(manifest.plugins).sort()).toEqual([
      "pi-autoresearch",
      "pi-context",
      "plannotator-pi-extension",
    ]);
    expect(manifest.plugins["plannotator-pi-extension"]).toMatchObject({
      kind: "npm",
      source: "npm:@plannotator/pi-extension",
    });
    expect(manifest.plugins["pi-autoresearch"]).toMatchObject({
      kind: "github",
      source: "https://github.com/davebcn87/pi-autoresearch",
    });
    expect(fs.existsSync(path.join(library, "pi-context", "index.ts"))).toBe(
      true,
    );
    const autoresearchPackageJson = JSON.parse(
      fs.readFileSync(
        path.join(library, "pi-autoresearch", "package.json"),
        "utf8",
      ),
    );
    expect(autoresearchPackageJson.pi.extensions).toEqual([
      "extensions/pi-autoresearch",
    ]);
    expect(
      fs.existsSync(
        path.join(
          library,
          "plannotator-pi-extension",
          "node_modules",
          ".prod-deps-installed",
        ),
      ),
    ).toBe(true);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("can enable default third-party plugins by symlinking them into the project", () => {
    const home = createTempDir();
    const project = createTempDir();
    const binDir = path.join(createTempDir(), "bin");
    createFakeInstallTools(binDir);

    execFileSync("bash", [installerPath, "--enable-defaults"], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    const target = path.join(project, ".pi", "extensions", "pi-context");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(
      fs.realpathSync(path.join(home, ".agents", "pi-plugins", "pi-context")),
    );
  });
});

describe("get_settings_file", () => {
  it("uses the local .pi/settings.json path for -l", () => {
    const tempDir = createTempDir();
    const result = runBash(
      `source ${bashString(libPath)}; get_settings_file -l ${bashString(tempDir)}`,
    );

    expect(result).toBe(path.join(tempDir, ".pi", "settings.json"));
  });

  it("uses the HOME-based global settings.json path by default", () => {
    const tempHome = createTempDir();
    const result = runBash(
      `source ${bashString(libPath)}; get_settings_file '' ${bashString(repoRoot)}`,
      { HOME: tempHome },
    );

    expect(result).toBe(path.join(tempHome, ".pi", "agent", "settings.json"));
  });
});
