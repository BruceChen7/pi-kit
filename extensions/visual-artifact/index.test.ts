import { beforeEach, describe, expect, it, vi } from "vitest";
import visualArtifactExtension from "./index.ts";
import { createToolHarness, type ToolHarness } from "./test-kit.ts";

/* ------------------------------------------------------------------ */
/*  Module mocks — keep the pipeline off real IO                       */
/* ------------------------------------------------------------------ */

vi.mock("./artifact-store.ts", () => ({
  writeArtifact: vi.fn(),
  readArtifact: vi.fn(),
  listArtifacts: vi.fn(),
}));
vi.mock("./glimpse-host.ts", () => ({
  openVisualArtifactWindow: vi.fn(),
}));
// getDefaultProjectRoot spawns `git rev-parse` — keep unit tests off it.
vi.mock("./paths.ts", () => ({
  getDefaultProjectRoot: () => "/repo",
  deriveProjectName: () => "repo",
}));

import { writeArtifact } from "./artifact-store.ts";
import { openVisualArtifactWindow } from "./glimpse-host.ts";

const mockedWrite = vi.mocked(writeArtifact);
const mockedOpen = vi.mocked(openVisualArtifactWindow);

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("create_visual_artifact", () => {
  let harness: ToolHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createToolHarness();
    visualArtifactExtension(harness.pi);
  });

  const callVisualArtifact = (params: Record<string, unknown>) =>
    harness.callTool("create_visual_artifact", params);

  it("registers the tool", () => {
    expect(harness.tools.has("create_visual_artifact")).toBe(true);
  });

  it("validates a plain spec, writes it, and opens the window", async () => {
    const res = await callVisualArtifact({
      slug: "diff-review-test",
      title: "Diff Review",
      artifactType: "review",
      nodes: JSON.stringify([
        { type: "heading", props: { text: "Title", level: "h1" } },
        { type: "text", props: { text: "plain", size: "md" } },
      ]),
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(
      'Visual artifact "Diff Review" created',
    );
    expect(res.content[0].text).toContain("Slug: diff-review-test");
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it("fails fast on an invalid spec (unknown node type) without writing", async () => {
    const res = await callVisualArtifact({
      slug: "bad",
      title: "Bad",
      nodes: JSON.stringify([{ type: "bogus-type", props: {} }]),
    });

    expect(res.isError).toBeTruthy();
    expect(res.content[0].text).toContain("Validation failed");
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });
});
