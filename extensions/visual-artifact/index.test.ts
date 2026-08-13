import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalldiffRunOutcome } from "../shared/calldiff-runner.ts";
import visualArtifactExtension from "./index.ts";
import {
  createToolHarness,
  diffResult,
  okOutcome,
  type ToolHarness,
} from "./test-kit.ts";

/* ------------------------------------------------------------------ */
/*  Module mocks — keep the pipeline off real IO / CLI                 */
/* ------------------------------------------------------------------ */

vi.mock("../shared/calldiff-runner.ts", () => ({
  runCalldiffJson: vi.fn(),
}));
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

import { runCalldiffJson } from "../shared/calldiff-runner.ts";
import { writeArtifact } from "./artifact-store.ts";
import { openVisualArtifactWindow } from "./glimpse-host.ts";

const mockedRun = vi.mocked(runCalldiffJson);
const mockedWrite = vi.mocked(writeArtifact);
const mockedOpen = vi.mocked(openVisualArtifactWindow);

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

const specParams = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  slug: "diff-review-test",
  title: "Diff Review",
  artifactType: "review",
  nodes: JSON.stringify(nodes),
  ...extra,
});

describe("create_visual_artifact with calldiff-callflow", () => {
  let harness: ToolHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createToolHarness();
    visualArtifactExtension(harness.pi);
  });

  const callVisualArtifact = (params: Record<string, unknown>) =>
    harness.callTool("create_visual_artifact", params);

  it("keeps zero behavior change when the spec has no calldiff nodes", async () => {
    const res = await callVisualArtifact(
      specParams([{ type: "text", props: { text: "plain", size: "md" } }]),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(
      'Visual artifact "Diff Review" created',
    );
    expect(res.content[0].text).toContain("Slug: diff-review-test");
    expect(mockedRun).not.toHaveBeenCalled();
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it("expands an embedded calldiff node and appends its summary", async () => {
    mockedRun.mockResolvedValue(okOutcome(diffResult));

    const res = await callVisualArtifact(
      specParams([
        { type: "text", props: { text: "exec summary", size: "xl" } },
        {
          type: "calldiff-callflow",
          props: { from: "main", to: "HEAD" },
        },
      ]),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Call-flow: 1 entrypoint(s)");

    // Written spec is the EXPANDED one — no macro node survives.
    const writtenSpec = mockedWrite.mock.calls[0][2] as { nodes: unknown[] };
    expect(JSON.stringify(writtenSpec.nodes)).not.toContain(
      "calldiff-callflow",
    );
    expect(
      (writtenSpec.nodes as { type?: string }[]).some((n) => n.type === "tabs"),
    ).toBe(true);
  });

  it("degrades a failed embedded node to a callout without failing the review", async () => {
    mockedRun.mockResolvedValue({
      status: "error",
      code: "no-git-repo",
      message: "not a repo",
    } satisfies CalldiffRunOutcome);

    const res = await callVisualArtifact(
      specParams([
        { type: "text", props: { text: "review body", size: "md" } },
        { type: "calldiff-callflow", props: {} },
      ]),
    );

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("degraded");
    expect(text).toContain("git work tree");

    // The artifact still renders — with a callout where the call flow was.
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    const writtenSpec = mockedWrite.mock.calls[0][2] as { nodes: unknown[] };
    expect(JSON.stringify(writtenSpec.nodes)).toContain(
      '"title":"Call-flow unavailable"',
    );
  });

  it("surfaces calldiff parse failures in the summary too", async () => {
    mockedRun.mockResolvedValue({ status: "ok", stdout: "not-json" });

    const res = await callVisualArtifact(
      specParams([{ type: "calldiff-callflow", props: {} }]),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("could not be parsed");
  });
});
