import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CalldiffResult } from "../shared/calldiff-json.ts";
import { runCalldiffJson } from "../shared/calldiff-runner.ts";
import {
  attachCallflowContext,
  formatCallflowAppendix,
} from "./callflow-context.ts";
import { loadConfig } from "./config.ts";

vi.mock("../shared/calldiff-runner.ts", () => ({
  runCalldiffJson: vi.fn(),
}));
vi.mock("./config.ts", () => ({
  loadConfig: vi.fn(),
}));

const makeNode = (
  key: string,
  label: string,
  status: "same" | "added" | "removed" = "same",
  children: ReturnType<typeof makeNode>[] = [],
) => ({ key, label, status, children });

const diffResult: CalldiffResult = {
  mode: "diff",
  from: "HEAD",
  to: "WORKTREE",
  trees: [
    {
      entry: "PiService.createAgentSession",
      ascii:
        "  PiService.createAgentSession(options)\n- ├─ AuthStorage.create()\n+ ├─ ModelRegistry.create()",
      tree: makeNode("root", "PiService.createAgentSession", "same", [
        makeNode("a", "AuthStorage.create()", "removed"),
        makeNode("b", "ModelRegistry.create()", "added"),
      ]),
    },
  ],
  ascii: "full",
};

describe("formatCallflowAppendix", () => {
  it("returns empty for non-diff modes", () => {
    const tree: CalldiffResult = {
      mode: "tree",
      ref: "HEAD",
      trees: [{ entry: "boot", ascii: "x", tree: makeNode("b", "boot()") }],
      ascii: "x",
    };
    expect(formatCallflowAppendix(tree)).toBe("");
  });

  it("returns empty when nothing changed", () => {
    expect(formatCallflowAppendix({ ...diffResult, trees: [] })).toBe("");
  });

  it("builds a markdown appendix with details blocks and ascii", () => {
    const appendix = formatCallflowAppendix(diffResult);
    expect(appendix).toContain("## Call-flow context");
    expect(appendix).toContain("calldiff diff `HEAD` `WORKTREE`");
    expect(appendix).toContain("1 个入口");
    expect(appendix).toContain(
      "<summary>PiService.createAgentSession</summary>",
    );
    expect(appendix).toContain("```text");
    expect(appendix).toContain("+ ├─ ModelRegistry.create()");
    expect(appendix).toContain("</details>");
  });

  it("caps entries and ascii lines", () => {
    const many: CalldiffResult = {
      ...diffResult,
      trees: Array.from({ length: 12 }, (_, i) => ({
        entry: `entry${i}`,
        ascii: Array.from({ length: 100 }, (_, j) => `line ${j}`).join("\n"),
        tree: makeNode(`e${i}`, `entry${i}()`),
      })),
    };
    const appendix = formatCallflowAppendix(many, {
      maxEntries: 3,
      maxAsciiLinesPerEntry: 10,
    });
    expect(appendix).toContain("9 more entrypoint(s) omitted");
    expect(appendix).toContain("90 more lines omitted");
    expect((appendix.match(/<summary>/g) ?? []).length).toBe(3);
  });

  it("includes the total line count", () => {
    const appendix = formatCallflowAppendix(diffResult);
    expect(appendix).toContain("共约 3 行");
  });
});

/* ------------------------------------------------------------------ */
/*  Shell wiring: attachCallflowContext (runner + config mocked)       */
/* ------------------------------------------------------------------ */

const diffStdout = JSON.stringify({
  mode: "diff",
  from: "HEAD",
  to: "working tree",
  trees: [
    {
      entry: "runCheckout",
      ascii: "+ mergeWorktrees()",
      tree: {
        key: "root",
        label: "runCheckout()",
        status: "same",
        children: [
          {
            key: "m",
            label: "mergeWorktrees()",
            status: "added",
            children: [],
          },
        ],
      },
    },
  ],
  ascii: "+ mergeWorktrees()",
});

const makeCtx = () => ({ cwd: "/repo" }) as unknown as ExtensionContext;

describe("attachCallflowContext", () => {
  it("returns the input unchanged when disabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({ callflowContext: null });
    const result = await attachCallflowContext(makeCtx(), "# Plan");
    expect(result).toEqual({
      markdown: "# Plan",
      attached: false,
      skippedReason: "not-enabled",
    });
    expect(runCalldiffJson).not.toHaveBeenCalled();
  });

  it("appends the appendix to the payload when enabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      callflowContext: { enabled: true },
    });
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: diffStdout,
    });
    const result = await attachCallflowContext(makeCtx(), "# Plan");

    expect(result.attached).toBe(true);
    expect(result.markdown).toContain("# Plan");
    expect(result.markdown).toContain("## Call-flow context");
    expect(result.markdown).toContain("<summary>runCheckout</summary>");
  });

  it("returns the input unchanged when calldiff fails", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      callflowContext: { enabled: true },
    });
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "error",
      code: "timeout",
      message: "timed out",
    });
    const result = await attachCallflowContext(makeCtx(), "# Plan");

    expect(result).toEqual({
      markdown: "# Plan",
      attached: false,
      skippedReason: "calldiff unavailable (timeout)",
    });
  });

  it("returns the input unchanged on unparseable output", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      callflowContext: { enabled: true },
    });
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: "not json",
    });
    const result = await attachCallflowContext(makeCtx(), "# Plan");

    expect(result).toEqual({
      markdown: "# Plan",
      attached: false,
      skippedReason: "calldiff output unparseable",
    });
  });

  it("skips when nothing changed", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      callflowContext: { enabled: true },
    });
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: JSON.stringify({
        mode: "diff",
        from: "HEAD",
        to: "working tree",
        trees: [],
        ascii: "",
      }),
    });
    const result = await attachCallflowContext(makeCtx(), "# Plan");

    expect(result).toEqual({
      markdown: "# Plan",
      attached: false,
      skippedReason: "no-changes",
    });
  });

  it("honors the configured from-ref and bounds the wait", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      callflowContext: { enabled: true, from: "HEAD~1" },
    });
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: diffStdout,
    });
    await attachCallflowContext(makeCtx(), "# Plan");

    expect(runCalldiffJson).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "diff",
        from: "HEAD~1",
        timeoutMs: 15_000,
        preferNpxFallback: false,
      }),
    );
  });
});
