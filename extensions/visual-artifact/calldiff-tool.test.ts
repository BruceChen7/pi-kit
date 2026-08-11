import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CalldiffRunErrorCode,
  CalldiffRunOutcome,
} from "../shared/calldiff-runner.ts";
import type { CalldiffResult } from "./calldiff-bridge.ts";
import { registerCalldiffTool } from "./calldiff-tool.ts";

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

import { runCalldiffJson } from "../shared/calldiff-runner.ts";
import { writeArtifact } from "./artifact-store.ts";
import { openVisualArtifactWindow } from "./glimpse-host.ts";

const mockedRun = vi.mocked(runCalldiffJson);
const mockedWrite = vi.mocked(writeArtifact);
const mockedOpen = vi.mocked(openVisualArtifactWindow);

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const makeNode = (
  key: string,
  label: string,
  status: "same" | "added" | "removed" = "same",
) => ({
  key,
  label,
  status,
  children: [],
});

const diffResult: CalldiffResult = {
  mode: "diff",
  from: "abc123",
  to: "WORKTREE",
  trees: [
    {
      entry: "boot",
      ascii: "  boot()\n+ ├─ register()",
      tree: makeNode("boot", "boot()"),
    },
  ],
  ascii: "  1 entrypoint",
};

const okOutcome = (result: CalldiffResult): CalldiffRunOutcome => ({
  status: "ok",
  stdout: JSON.stringify(result),
});

const errOutcome = (
  code: CalldiffRunErrorCode,
  message: string,
): CalldiffRunOutcome => ({ status: "error", code, message });

/* ------------------------------------------------------------------ */
/*  Fake pi + tool capture                                             */
/* ------------------------------------------------------------------ */

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { cwd?: string },
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}>;

type RegisteredTool = { name: string; execute: ToolExecute };

const tools = new Map<string, RegisteredTool>();
const pi = {
  registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
  sendUserMessage: vi.fn(),
} as unknown as ExtensionAPI;

const callTool = async (params: Record<string, unknown>) => {
  const tool = tools.get("create_calldiff_artifact");
  if (!tool) throw new Error("create_calldiff_artifact not registered");
  return tool.execute("t1", params, undefined, undefined, { cwd: "/repo" });
};

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("create_calldiff_artifact (thin wrapper)", () => {
  beforeEach(() => {
    tools.clear();
    vi.clearAllMocks();
    registerCalldiffTool(pi);
  });

  it("runs the shared pipeline and reports the call-flow summary", async () => {
    mockedRun.mockResolvedValue(okOutcome(diffResult));

    const res = await callTool({ from: "abc123", to: "WORKTREE" });

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

    const res = await callTool({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("calldiff failed");
    expect(res.content[0].text).toContain("git work tree");
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("returns an error result for missing session cwd", async () => {
    const tool = tools.get("create_calldiff_artifact");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("create_calldiff_artifact not registered");
    const res = await tool.execute("t1", {}, undefined, undefined, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Missing session cwd");
  });

  it("validates tree mode requires entry without running calldiff", async () => {
    const res = await callTool({ mode: "tree" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("--entry");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("passes mode/entry/target through to the runner", async () => {
    mockedRun.mockResolvedValue(okOutcome(diffResult));

    await callTool({ mode: "reach", entry: "A", target: "B" });

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

    const res = await callTool({ mode: "reach", entry: "A", target: "B" });

    expect(res.isError).toBeFalsy();
    const boot = mockedOpen.mock.calls[0][0].bootData as {
      artifactSpec?: { slug: string; title: string };
    };
    expect(boot.artifactSpec?.slug).toBe("calldiff-reach-a-to-b");
    expect(boot.artifactSpec?.title).toBe("Call paths: A → B");
  });

  it("never leaks 'X → Y' placeholders into reach titles", async () => {
    mockedRun.mockResolvedValue(errOutcome("no-git-repo", "not a repo"));

    const res = await callTool({ mode: "reach" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("Call paths: ?");
    expect(res.content[0].text).not.toContain("→ ?");
  });
});
