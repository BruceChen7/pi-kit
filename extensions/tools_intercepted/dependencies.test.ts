import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("tools_intercepted package manifest", () => {
  it("keeps exactly one typebox generation, the one pi bundles and aliases", () => {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // 运行时不自己带一份：pi 的 jiti alias 把 `typebox` 指到宿主自带的那个版本。
    // devDependencies 那份只给 `tsc --noEmit` 和 vitest 用，钉成宿主自带的精确版本，
    // 否则本地类型会与运行时静默分叉（这次迁移要消灭的就是这个）。
    const hostPackagePath = path.resolve(
      process.cwd(),
      "node_modules/@earendil-works/pi-coding-agent/package.json",
    );
    const hostPackage = JSON.parse(
      fs.readFileSync(hostPackagePath, "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.devDependencies?.typebox).toBe(
      hostPackage.dependencies?.typebox,
    );
    expect(packageJson.dependencies?.typebox).toBeUndefined();
    expect(packageJson.dependencies?.["@sinclair/typebox"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@sinclair/typebox"]).toBeUndefined();
  });

  it("declares tools_intercepted as a Pi extension so the PATH shims load", () => {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as {
      pi?: { extensions?: string[] };
    };

    expect(packageJson.pi?.extensions).toContain(
      "./extensions/tools_intercepted",
    );
  });
});
