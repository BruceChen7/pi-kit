import { describe, expect, it, vi } from "vitest";
import { runCalldiffJson } from "./calldiff-runner.ts";
import { fetchCalldiffDiff, truncateAscii } from "./callflow.ts";

vi.mock("./calldiff-runner.ts", () => ({
  runCalldiffJson: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  truncateAscii (pure)                                               */
/* ------------------------------------------------------------------ */

describe("truncateAscii", () => {
  it("returns the original string within the limit", () => {
    expect(truncateAscii("a\nb", 5)).toBe("a\nb");
  });

  it("truncates and appends the omission marker", () => {
    const ascii = ["a", "b", "c", "d"].join("\n");
    expect(truncateAscii(ascii, 2)).toBe("a\nb\n… 2 more lines omitted");
  });

  it("normalizes CRLF before counting lines", () => {
    expect(truncateAscii("a\r\nb\r\nc", 2)).toBe(
      "a\nb\n… 1 more lines omitted",
    );
  });

  it("keeps the exact original when lines equal the cap", () => {
    expect(truncateAscii("a\nb", 2)).toBe("a\nb");
  });
});

/* ------------------------------------------------------------------ */
/*  fetchCalldiffDiff (shell glue wiring)                              */
/* ------------------------------------------------------------------ */

const okStdout = JSON.stringify({
  mode: "diff",
  from: "HEAD",
  to: "working tree",
  trees: [
    {
      entry: "runCheckout",
      ascii: "x",
      tree: {
        key: "runCheckout",
        label: "runCheckout()",
        status: "added",
        children: [],
      },
    },
  ],
  ascii: "x",
});

describe("fetchCalldiffDiff", () => {
  it("returns the parsed result on success", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: okStdout,
    });
    const result = await fetchCalldiffDiff("/repo", "HEAD");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.mode).toBe("diff");
  });

  it("maps runner errors to typed outcomes", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "error",
      code: "no-git-repo",
      message: "not a repo",
    });
    const result = await fetchCalldiffDiff("/repo", undefined);
    expect(result).toEqual({ status: "error", code: "no-git-repo" });
  });

  it("maps unparseable output to parse-error", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: "not json",
    });
    const result = await fetchCalldiffDiff("/repo", "HEAD");
    expect(result).toEqual({ status: "error", code: "parse-error" });
  });

  it("forwards timeout and npx-fallback policy to the runner", async () => {
    vi.mocked(runCalldiffJson).mockResolvedValueOnce({
      status: "ok",
      stdout: okStdout,
    });
    await fetchCalldiffDiff("/repo", "HEAD", {
      timeoutMs: 15_000,
      preferNpxFallback: false,
    });
    expect(runCalldiffJson).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        mode: "diff",
        from: "HEAD",
        timeoutMs: 15_000,
        preferNpxFallback: false,
      }),
    );
  });
});
