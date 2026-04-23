import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("tools_intercepted package manifest", () => {
  it("declares @sinclair/typebox because runtime extensions import it", () => {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["@sinclair/typebox"]).toBeTruthy();
  });
});
