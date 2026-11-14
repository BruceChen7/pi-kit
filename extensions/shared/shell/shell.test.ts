import { describe, expect, it } from "vitest";
import {
  analyzeShell,
  commandSegments,
  effectiveCommand,
  hasLoopStructure,
  segmentWritesStdoutToFile,
  tokenizeShell,
} from "./index.ts";

const wordsOf = (source: string): string[] =>
  tokenizeShell(source)
    .tokens.filter((token) => token.kind === "word")
    .map((token) => (token.kind === "word" ? token.text : ""));

const segmentsOf = (source: string) => analyzeShell(source).segments;

/** 取第 n 段；取不到就让用例直接失败，而不是靠 `!` 断言。 */
const segmentAt = (source: string, index: number) => {
  const segment = segmentsOf(source)[index];
  if (segment === undefined) {
    throw new Error(`expected a segment at ${index} in ${source}`);
  }
  return segment;
};

// ── 词法 ────────────────────────────────────────────────────

describe("tokenizeShell", () => {
  it("splits words and keeps them unquoted", () => {
    expect(wordsOf("git commit -m 'a b'")).toEqual([
      "git",
      "commit",
      "-m",
      "a b",
    ]);
  });

  it("keeps a quoted space inside one word", () => {
    const tokens = tokenizeShell('echo "a  b"').tokens;
    expect(tokens.filter((token) => token.kind === "word")).toHaveLength(2);
  });

  it("marks an expansion as dynamic instead of guessing its value", () => {
    const [word] = tokenizeShell("$CMD --flag").tokens;
    expect(word).toMatchObject({ kind: "word", dynamic: true });
  });

  it("does not read a comment as a word", () => {
    expect(wordsOf("echo hi # sleep 30")).toEqual(["echo", "hi"]);
  });

  it("keeps a # in the middle of a word", () => {
    expect(wordsOf("echo a#b")).toEqual(["echo", "a#b"]);
  });

  it("reports an unterminated quote", () => {
    expect(tokenizeShell('echo "oops').errors).toEqual([
      "unterminated double quote",
    ]);
  });

  it("drops a heredoc body but keeps its delimiter", () => {
    const source = [
      "cat > /tmp/x.sh <<'EOF'",
      "sleep 20",
      "EOF",
      "bash /tmp/x.sh",
    ].join("\n");
    const result = tokenizeShell(source);

    expect(wordsOf(source)).toEqual([
      "cat",
      "/tmp/x.sh",
      "EOF",
      "bash",
      "/tmp/x.sh",
    ]);
    const heredoc = result.tokens.find((token) => token.kind === "heredoc");
    expect(heredoc).toMatchObject({ kind: "heredoc", body: "sleep 20" });
  });
});

// ── 结构 ────────────────────────────────────────────────────

describe("analyzeShell", () => {
  it("splits a pipeline into segments with joiners", () => {
    const segments = segmentsOf("grep -c x /tmp/a.log | head -1");

    expect(segments).toHaveLength(2);
    expect(segments[1]?.joiner).toBe("|");
  });

  it("splits on && and ;", () => {
    const segments = segmentsOf("a && b; c");
    expect(segments.map((segment) => segment.joiner)).toEqual([
      null,
      "&&",
      ";",
    ]);
  });

  it("records redirects without treating the target as an argument", () => {
    const segment = segmentAt("cmd > /tmp/log 2>&1", 0);
    expect(segment.words.map((word) => word.text)).toEqual(["cmd"]);
    expect(segment.redirects.map((redirect) => redirect.operator)).toEqual([
      ">",
      ">&",
    ]);
    expect(segmentWritesStdoutToFile(segment)).toBe(true);
  });

  it("keeps a stderr-only redirect out of the stdout judgement", () => {
    const segment = segmentAt("cmd 2>/dev/null", 0);
    expect(segmentWritesStdoutToFile(segment)).toBe(false);
  });

  it("collects structure keywords", () => {
    const analysis = analyzeShell("for i in 1 2; do sleep 3; done");
    expect(analysis.structure).toEqual(
      expect.arrayContaining(["for", "do", "done"]),
    );
    expect(hasLoopStructure(analysis)).toBe(true);
  });

  it("does not take a loop keyword inside quotes as structure", () => {
    const analysis = analyzeShell('echo "for i in 1; do done"');
    expect(hasLoopStructure(analysis)).toBe(false);
  });
});

// ── 包装前缀与嵌套脚本 ──────────────────────────────────────

describe("effectiveCommand", () => {
  it("skips sudo and env prefixes", () => {
    expect(
      effectiveCommand(segmentAt("sudo env A=1 rm -rf x", 0)),
    ).toMatchObject({ name: "rm" });
  });

  it("skips a timeout duration", () => {
    const command = effectiveCommand(segmentAt("timeout 90 glab ci status", 0));
    expect(command.name).toBe("glab");
    expect(command.args.map((arg) => arg.text)).toEqual(["ci", "status"]);
  });

  it("skips -s SIG for timeout", () => {
    const command = effectiveCommand(segmentAt("timeout -s KILL 90 cmd", 0));
    expect(command.name).toBe("cmd");
  });

  it("reports a dynamic command name", () => {
    const command = effectiveCommand(segmentAt("$CMD --flag", 0));
    expect(command).toMatchObject({ name: null, dynamic: true });
  });
});

describe("nested scripts", () => {
  it("parses a literal sh -c script", () => {
    const analysis = analyzeShell('sh -c "sleep 30"');

    expect(analysis.nested).toHaveLength(1);
    expect(analysis.nested[0]?.source).toBe("sleep 30");
    expect(analysis.unresolved).toEqual([]);
  });

  it("walks nested segments through commandSegments", () => {
    const analysis = analyzeShell('bash -c "for i in 1; do sleep 3; done"');
    const flat = commandSegments(analysis);

    expect(flat.map(({ depth }) => depth)).toEqual([0, 1, 1, 1]);
    expect(hasLoopStructure(analysis)).toBe(true);
  });

  it("reports a dynamic -c script as unresolved", () => {
    const analysis = analyzeShell('sh -c "$SCRIPT"');

    expect(analysis.nested).toEqual([]);
    expect(analysis.unresolved).toEqual([
      expect.objectContaining({ kind: "nested-shell-dynamic" }),
    ]);
  });

  it("parses a literal eval", () => {
    const analysis = analyzeShell('eval "sleep 30"');
    expect(analysis.nested[0]?.source).toBe("sleep 30");
  });

  it("finds -c even when it is combined with other short flags", () => {
    expect(analyzeShell('bash -lc "sleep 60"').nested[0]?.source).toBe(
      "sleep 60",
    );
    expect(analyzeShell('sh -ec "tail -f x"').nested[0]?.source).toBe(
      "tail -f x",
    );
  });

  it("does not read a script path as a script body", () => {
    // `sh /tmp/poll.sh` 执行的是文件，不是一段内联脚本文本
    expect(analyzeShell("sh /tmp/poll.sh").nested).toEqual([]);
  });

  it("reports too-deep nesting instead of silently allowing it", () => {
    // 5 层嵌套，超过 MAX_NESTING_DEPTH(4)
    let command = "echo hi";
    for (let depth = 0; depth < 5; depth += 1) {
      command = `sh -c ${JSON.stringify(command)}`;
    }

    expect(
      analyzeShell(command).unresolved.map((entry) => entry.kind),
    ).toContain("too-deep");
  });
});
