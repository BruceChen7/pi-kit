import { describe, expect, it, vi } from "vitest";

import {
  openProjectWorkspace,
  type ProjectOpenCandidate,
} from "./project-entry-controller";

function createCandidate(): ProjectOpenCandidate<{ name: string }> {
  return {
    id: "demo",
    name: "demo",
    handle: { name: "demo" },
    lastUsedAt: "2026-04-21T12:00:00.000Z",
  };
}

describe("openProjectWorkspace", () => {
  it("returns an access error when restore cannot use the stored handle", async () => {
    const result = await openProjectWorkspace({
      candidate: createCandidate(),
      mode: "restore",
      ensureAccess: vi.fn(async () => false),
      readBoard: vi.fn(),
    });

    expect(result).toEqual({
      status: "access-error",
      message:
        "Unable to restore the last project. Please select a folder again.",
    });
  });

  it("returns init-required when the selected project has no board file", async () => {
    const result = await openProjectWorkspace({
      candidate: createCandidate(),
      mode: "select",
      ensureAccess: vi.fn(async () => true),
      readBoard: vi.fn(async () => ({ status: "missing" as const })),
    });

    expect(result).toEqual({
      status: "init-required",
      project: createCandidate(),
    });
  });
});
