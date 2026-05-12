import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RootPackageJson = {
  dependencies?: Record<string, string>;
  pi?: {
    extensions?: string[];
  };
};

function readRootPackageJson(): RootPackageJson {
  const packageJsonPath = path.resolve(
    import.meta.dirname,
    "../../package.json",
  );
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
}

describe("codex-web-search package integration", () => {
  it("registers the extension in the root pi package manifest", () => {
    const packageJson = readRootPackageJson();

    expect(packageJson.pi?.extensions).toContain(
      "./extensions/codex-web-search",
    );
  });

  it("declares defuddle as a runtime dependency", () => {
    const packageJson = readRootPackageJson();

    expect(packageJson.dependencies?.defuddle).toBe("0.14.0");
  });
});
