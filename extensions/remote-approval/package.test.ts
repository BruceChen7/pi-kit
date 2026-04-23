import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("remote-approval package integration", () => {
  it("registers the extension in the root pi package manifest", () => {
    const packageJsonPath = path.resolve(
      import.meta.dirname,
      "../../package.json",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf-8"),
    ) as {
      pi?: {
        extensions?: string[];
      };
    };

    expect(packageJson.pi?.extensions).toContain(
      "./extensions/remote-approval",
    );
  });
});
