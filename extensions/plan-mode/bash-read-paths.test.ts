import { describe, expect, it } from "vitest";
import { readPathsFromBashCommand } from "./bash-read-paths.js";

describe("readPathsFromBashCommand", () => {
  it("takes the path out of a sed range read", () => {
    expect(readPathsFromBashCommand("sed -n '1,120p' src/a.ts")).toEqual([
      "src/a.ts",
    ]);
  });

  it("reads paths from every stage of a pipeline", () => {
    expect(readPathsFromBashCommand("cat src/a.ts | head -20")).toEqual([
      "src/a.ts",
    ]);
  });

  it("keeps quoted paths intact", () => {
    expect(readPathsFromBashCommand("cat 'src/my file.ts'")).toEqual([
      "src/my file.ts",
    ]);
  });

  it("skips env assignments in front of the command", () => {
    expect(readPathsFromBashCommand("FOO=1 cat src/a.ts")).toEqual([
      "src/a.ts",
    ]);
  });

  it("ignores in-place sed, which writes", () => {
    expect(readPathsFromBashCommand("sed -i '' 's/a/b/' src/a.ts")).toEqual([]);
    expect(
      readPathsFromBashCommand("sed --in-place 's/a/b/' src/a.ts"),
    ).toEqual([]);
  });

  it("ignores anything that redirects output", () => {
    expect(readPathsFromBashCommand("cat src/a.ts > /tmp/out.txt")).toEqual([]);
    expect(readPathsFromBashCommand("echo hi > src/a.ts")).toEqual([]);
  });

  it("ignores pattern scans that do not print file content", () => {
    expect(readPathsFromBashCommand("grep -n needle src/a.ts")).toEqual([]);
    expect(readPathsFromBashCommand("python3 tool.py src/a.ts")).toEqual([]);
  });

  it("resolves paths against the directory the command changes into", () => {
    expect(readPathsFromBashCommand("cd src && cat a.ts")).toEqual([
      "src/a.ts",
    ]);
    expect(readPathsFromBashCommand("cd src && cd sub && cat a.ts")).toEqual([
      "src/sub/a.ts",
    ]);
    expect(readPathsFromBashCommand("cd /abs && cat a.ts")).toEqual([
      "/abs/a.ts",
    ]);
    expect(readPathsFromBashCommand("cd .. && cat x.ts")).toEqual(["../x.ts"]);
    expect(readPathsFromBashCommand("cd $DIR && cat a.ts")).toEqual([]);
    expect(readPathsFromBashCommand("cd $DIR && cat /abs/a.ts")).toEqual([
      "/abs/a.ts",
    ]);
  });

  it("ignores home-relative paths the shell would expand", () => {
    expect(readPathsFromBashCommand("cat ~/notes.md")).toEqual([]);
  });

  it("ignores in-place sed with combined short flags", () => {
    expect(readPathsFromBashCommand("sed -ni 's/a/b/p' src/a.ts")).toEqual([]);
    expect(readPathsFromBashCommand("sed -ni.bak 's/a/b/p' src/a.ts")).toEqual(
      [],
    );
  });

  it("keeps reads that share a command with unrelated stages", () => {
    expect(readPathsFromBashCommand("cat src/a.ts && rm src/b.ts")).toEqual([
      "src/a.ts",
    ]);
  });

  it("dedupes the same file read twice", () => {
    expect(
      readPathsFromBashCommand("cat src/a.ts && tail -n 5 src/a.ts"),
    ).toEqual(["src/a.ts"]);
  });

  it("resolves a for-loop variable to the literals in its header", () => {
    // 实录（2026-10-30 03:49 会话）：agent 这样读过 review/SKILL.md，
    // 门禁没登记，随后 edit 被拦。
    expect(
      readPathsFromBashCommand(
        'for f in skills/review/SKILL.md skills/research/SKILL.md; do echo "##### $f"; cat -n "$f"; done',
      ),
    ).toEqual(["skills/review/SKILL.md", "skills/research/SKILL.md"]);
    expect(
      readPathsFromBashCommand(
        'for f in prompts/article-read.md prompts/article-buddy.md; do echo "=== $f"; head -c 600 "$f" | cat -A; done',
      ),
    ).toEqual(["prompts/article-read.md", "prompts/article-buddy.md"]);
  });

  it("keeps a loop variable unexpanded when its header is not literals", () => {
    expect(
      readPathsFromBashCommand('for f in $(ls); do cat "$f"; done'),
    ).toEqual([]);
    expect(readPathsFromBashCommand("for f in *.md; do cat $f; done")).toEqual(
      [],
    );
  });

  it("leaves a cd into a loop variable unresolved", () => {
    expect(
      readPathsFromBashCommand(
        'for d in src lib; do cd "$d" && cat a.ts; done',
      ),
    ).toEqual([]);
  });
});
