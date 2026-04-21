import { describe, expect, it } from "vitest";

import { evaluateFeatureStartWorkspace } from "./feature-start-workspace-guard.js";

describe("evaluateFeatureStartWorkspace", () => {
  it("allows a clean workspace", () => {
    expect(
      evaluateFeatureStartWorkspace({
        summary: {
          staged: 0,
          unstaged: 0,
          untracked: 0,
          dirty: false,
        },
        dirtyPaths: [],
      }),
    ).toEqual({ allow: true });
  });

  it("allows only feature-setup managed dirty paths", () => {
    expect(
      evaluateFeatureStartWorkspace({
        summary: {
          staged: 0,
          unstaged: 1,
          untracked: 0,
          dirty: true,
        },
        dirtyPaths: [".config/wt.toml", ".pi/third_extension_settings.json"],
      }),
    ).toEqual({
      allow: true,
      notifyLevel: "info",
      notifyMessage:
        "Workspace has only /feature-setup managed changes (.config/wt.toml, .pi/third_extension_settings.json). Continuing /feature-start.",
    });
  });

  it("allows an untracked-only workspace", () => {
    expect(
      evaluateFeatureStartWorkspace({
        summary: {
          staged: 0,
          unstaged: 0,
          untracked: 1,
          dirty: true,
        },
        dirtyPaths: ["notes.txt"],
      }),
    ).toEqual({
      allow: true,
      notifyLevel: "info",
      notifyMessage:
        "Workspace has only untracked files (notes.txt). Continuing /feature-start.",
    });
  });

  it("blocks when unstaged tracked changes are present", () => {
    expect(
      evaluateFeatureStartWorkspace({
        summary: {
          staged: 0,
          unstaged: 1,
          untracked: 0,
          dirty: true,
        },
        dirtyPaths: ["README.md"],
      }),
    ).toEqual({
      allow: false,
      notifyLevel: "warning",
      notifyMessage:
        "Repository is dirty (staged 0, unstaged 1, untracked 0). Commit/stash first.",
    });
  });

  it("blocks when staged tracked changes are present", () => {
    expect(
      evaluateFeatureStartWorkspace({
        summary: {
          staged: 1,
          unstaged: 0,
          untracked: 0,
          dirty: true,
        },
        dirtyPaths: ["README.md"],
      }),
    ).toEqual({
      allow: false,
      notifyLevel: "warning",
      notifyMessage:
        "Repository is dirty (staged 1, unstaged 0, untracked 0). Commit/stash first.",
    });
  });

  it("blocks mixed untracked and tracked changes", () => {
    expect(
      evaluateFeatureStartWorkspace({
        summary: {
          staged: 0,
          unstaged: 1,
          untracked: 1,
          dirty: true,
        },
        dirtyPaths: ["README.md", "notes.txt"],
      }),
    ).toEqual({
      allow: false,
      notifyLevel: "warning",
      notifyMessage:
        "Repository is dirty (staged 0, unstaged 1, untracked 1). Commit/stash first.",
    });
  });
});
