import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalldiffRunOutcome } from "../shared/calldiff-runner.ts";
import type { CalldiffResult } from "./calldiff-bridge.ts";
import visualArtifactExtension from "./index.ts";

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

const diffResult: CalldiffResult = {
  mode: "diff",
  from: "main",
  to: "HEAD",
  trees: [
    {
      entry: "boot",
      ascii: "  boot()\n+ ├─ register()",
      tree: { key: "boot", label: "boot()", status: "same", children: [] },
    },
  ],
  ascii: "  1 entrypoint",
};

const okOutcome = (result: CalldiffResult): CalldiffRunOutcome => ({
  status: "ok",
  stdout: JSON.stringify(result),
});

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

const tools = new Map<string, { name: string; execute: ToolExecute }>();

const pi = {
  registerTool: vi.fn((tool: { name: string; execute: ToolExecute }) =>
    tools.set(tool.name, tool),
  ),
  registerCommand: vi.fn(),
  sendUserMessage: vi.fn(),
} as unknown as ExtensionAPI;

const callVisualArtifact = async (params: Record<string, unknown>) => {
  const tool = tools.get("create_visual_artifact");
  if (!tool) throw new Error("create_visual_artifact not registered");
  return tool.execute("t1", params, undefined, undefined, { cwd: "/repo" });
};

const specParams = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  slug: "diff-review-test",
  title: "Diff Review",
  artifactType: "review",
  nodes: JSON.stringify(nodes),
  ...extra,
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("create_visual_artifact with calldiff-callflow", () => {
  beforeEach(() => {
    tools.clear();
    vi.clearAllMocks();
    visualArtifactExtension(pi);
  });

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
      (writtenSpec.nodes as { type?: string }[]).some(
        (n) => n.type === "section",
      ),
    ).toBe(true);
  });

  it("degrades a failed embedded node to a callout without failing the review", async () => {
    mockedRun.mockResolvedValue({
      status: "error",
      code: "no-git-repo",
      message: "not a repo",
    });

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
