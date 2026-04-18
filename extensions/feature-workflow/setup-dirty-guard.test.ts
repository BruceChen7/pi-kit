import { describe, expect, it } from "vitest";

import {
  areOnlyFeatureSetupManagedDirtyPaths,
  isFeatureSetupManagedPath,
} from "./setup-dirty-guard.js";

describe("feature-setup dirty guard allowlist", () => {
  it("accepts setup-managed paths", () => {
    expect(isFeatureSetupManagedPath(".pi/pi-feature-workflow-links.sh")).toBe(
      true,
    );
    expect(
      isFeatureSetupManagedPath(".config/pi-feature-workflow-links.sh"),
    ).toBe(true);
    expect(isFeatureSetupManagedPath(".gitignore")).toBe(true);
    expect(isFeatureSetupManagedPath("./.worktreeinclude")).toBe(true);
    expect(isFeatureSetupManagedPath(".config\\wt.toml")).toBe(true);
  });

  it("rejects non-managed paths", () => {
    expect(isFeatureSetupManagedPath("package.json")).toBe(false);
    expect(isFeatureSetupManagedPath(".config/custom.sh")).toBe(false);
  });

  it("returns true only when all dirty paths are setup-managed", () => {
    expect(
      areOnlyFeatureSetupManagedDirtyPaths([
        ".pi/third_extension_settings.json",
        ".pi/pi-feature-workflow-links.sh",
        ".gitignore",
      ]),
    ).toBe(true);

    expect(
      areOnlyFeatureSetupManagedDirtyPaths([
        ".pi/pi-feature-workflow-links.sh",
        "src/index.ts",
      ]),
    ).toBe(false);
  });

  it("does not allow empty dirty path lists", () => {
    expect(areOnlyFeatureSetupManagedDirtyPaths([])).toBe(false);
  });
});
