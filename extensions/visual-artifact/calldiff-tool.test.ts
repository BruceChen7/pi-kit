import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCalldiffTool } from "./calldiff-tool.ts";
import {
  createToolHarness,
  diffResult,
  errOutcome,
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

describe("create_calldiff_artifact (thin wrapper)", () => {
  let harness: ToolHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createToolHarness();
    registerCalldiffTool(harness.pi);
  });

  it("runs the shared pipeline and reports the call-flow summary", async () => {
    mockedRun.mockResolvedValue(okOutcome(diffResult));

    const res = await harness.callTool("create_calldiff_artifact", {
      from: "abc123",
      to: "WORKTREE",
    });

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("Calldiff artifact");
    expect(text).toContain("Call-flow: 1 entrypoint(s)");

    // Standalone artifact: exactly one window was opened on the expanded spec.
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const writtenSpec = mockedWrite.mock.calls[0][2] as { nodes: unknown[] };
    expect(JSON.stringify(writtenSpec.nodes)).not.toContain(
      "calldiff-callflow",
    );
    expect(mockedOpen.mock.calls[0][0].bootData).toMatchObject({
      view: "artifact",
    });
    const boot = mockedOpen.mock.calls[0][0].bootData as {
      artifactSpec?: { slug: string };
    };
    expect(boot.artifactSpec?.slug).toBe("calldiff-diff-abc123-worktree");
  });

  it("returns an error result when the only node degrades (no git repo)", async () => {
    mockedRun.mockResolvedValue(errOutcome("no-git-repo", "not a repo"));

    const res = await harness.callTool("create_calldiff_artifact", {});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("calldiff failed");
    expect(res.content[0].text).toContain("git work tree");
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("returns an error result for missing session cwd", async () => {
    const res = await harness.callTool("create_calldiff_artifact", {}, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Missing session cwd");
  });

  it("validates tree mode requires entry without running calldiff", async () => {
    const res = await harness.callTool("create_calldiff_artifact", {
      mode: "tree",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("--entry");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  // Single DTO smoke: the tool's params → runner-options mapping is already
  // unit-tested (toCalldiffRunOptions) and integration-tested
  // (resolveCalldiffNodes) — this only proves the full chain stays wired.
  it("passes mode/entry/target through to the runner", async () => {
    mockedRun.mockResolvedValue(okOutcome(diffResult));

    await harness.callTool("create_calldiff_artifact", {
      mode: "reach",
      entry: "A",
      target: "B",
    });

    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][0]).toMatchObject({
      mode: "reach",
      entries: ["A"],
      target: "B",
      cwd: "/repo",
    });
  });

  it("derives reach titles/slugs from entry → target, not from/to refs", async () => {
    mockedRun.mockResolvedValue(
      okOutcome({
        mode: "reach",
        ref: "WORKTREE",
        from: "A",
        to: "B",
        paths: [
          {
            entry: "A → B",
            ascii: "  A\n  └─ B",
            tree: { key: "A", label: "A", children: [] },
          },
        ],
        ascii: "  1 path",
      }),
    );

    const res = await harness.callTool("create_calldiff_artifact", {
      mode: "reach",
      entry: "A",
      target: "B",
    });

    expect(res.isError).toBeFalsy();
    const boot = mockedOpen.mock.calls[0][0].bootData as {
      artifactSpec?: { slug: string; title: string };
    };
    expect(boot.artifactSpec?.slug).toBe("calldiff-reach-a-to-b");
    expect(boot.artifactSpec?.title).toBe("Call paths: A → B");
  });

  it("never leaks 'X → Y' placeholders into reach titles", async () => {
    mockedRun.mockResolvedValue(errOutcome("no-git-repo", "not a repo"));

    const res = await harness.callTool("create_calldiff_artifact", {
      mode: "reach",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("Call paths: ?");
    expect(res.content[0].text).not.toContain("→ ?");
  });
});
