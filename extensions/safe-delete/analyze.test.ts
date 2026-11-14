/**
 * 判定核心的纯函数测试：没有 fs、没有 subprocess、没有 UI、没有计时器。
 * 目录大小由端口给，所以"大目录删除"这种分支可以确定性地测到。
 */

import { describe, expect, it, vi } from "vitest";
import {
  type AnalyzePorts,
  analyzeCommand,
  DEFAULT_SIZE_THRESHOLD,
  formatThreats,
  protectedPathsFor,
} from "./analyze.ts";

const HOME = "/home/u";

const ports = (overrides: Partial<AnalyzePorts> = {}): AnalyzePorts => ({
  pathSize: () => 0,
  protectedPaths: protectedPathsFor(HOME),
  sizeThreshold: DEFAULT_SIZE_THRESHOLD,
  home: HOME,
  ...overrides,
});

const threatsOf = (
  command: string,
  overrides: Partial<AnalyzePorts> = {},
  cwd = "/repo",
) => analyzeCommand({ command, cwd, ports: ports(overrides) });

const descriptions = (command: string, overrides: Partial<AnalyzePorts> = {}) =>
  threatsOf(command, overrides).map((threat) => threat.description);

const MB = 1024 * 1024;

describe("analyzeCommand: nothing to confirm", () => {
  it.each([
    "npm format",
    "npm run format",
    "biome format --write .",
    "ls -la",
    "git status",
    "echo hello > out.txt",
  ])("leaves %s alone", (command) => {
    expect(threatsOf(command)).toEqual([]);
  });

  it("does not read prose inside a heredoc as a deletion", () => {
    const command = [
      "cat >> notes.md <<'EOF'",
      "we should never run rm -rf / in a script",
      "EOF",
      "echo done",
    ].join("\n");

    expect(threatsOf(command)).toEqual([]);
  });
});

describe("analyzeCommand: protected paths", () => {
  it("flags rm of a protected path as critical", () => {
    expect(threatsOf("rm -rf ~/Documents")[0]).toMatchObject({
      severity: "critical",
    });
    expect(descriptions("rm -rf ~/Documents")[0]).toContain(
      `${HOME}/Documents`,
    );
  });

  it("flags deleting a parent of a protected path", () => {
    expect(descriptions("rm -rf /home")).toEqual([
      expect.stringContaining("/home"),
    ]);
  });

  it("flags a wildcard explosion", () => {
    expect(descriptions("rm -rf /*")).toEqual([
      expect.stringContaining("Wildcard deletion"),
    ]);
  });

  it("escalates a sudo command to critical", () => {
    const [threat] = threatsOf("sudo rm -rf ~/Documents");
    expect(threat?.severity).toBe("critical");
    expect(threat?.description.startsWith("[sudo] ")).toBe(true);
  });

  it("flags a recursive chmod on a protected path", () => {
    expect(descriptions("chmod -R 777 ~/Documents")).toEqual([
      expect.stringContaining("Recursive chmod"),
    ]);
  });

  it("flags find -delete rooted at a protected path", () => {
    expect(descriptions("find /home/u/Documents -name '*.md' -delete")).toEqual(
      [expect.stringContaining("find -delete")],
    );
  });
});

describe("analyzeCommand: size threshold", () => {
  it("flags a recursive delete of a large directory", () => {
    const [threat] = threatsOf("rm -rf /repo/build", {
      pathSize: () => 200 * MB,
    });

    expect(threat?.severity).toBe("high");
    expect(threat?.description).toContain("200.0MB");
  });

  it("leaves a small recursive delete alone", () => {
    expect(threatsOf("rm -rf /repo/build", { pathSize: () => MB })).toEqual([]);
  });

  it("only measures the size when the command is recursive", () => {
    const pathSize = vi.fn(() => 200 * MB);
    threatsOf("rm /repo/build/file.txt", { pathSize });

    expect(pathSize).not.toHaveBeenCalled();
  });

  it("flags truncating a large file", () => {
    expect(
      descriptions("truncate -s 0 /repo/big.log", { pathSize: () => 200 * MB }),
    ).toEqual([expect.stringContaining("Truncating large file")]);
  });
});

describe("analyzeCommand: device and history destruction", () => {
  it.each([
    ["dd if=/dev/zero of=/dev/sda", "dd writing"],
    ["mkfs.ext4 /dev/sda1", "Filesystem format"],
    ["mv ~/x /dev/null", "mv to /dev/null"],
    ["ls | xargs rm", "xargs rm"],
    ["git clean -fdx", "git clean"],
  ])("flags %s", (command, expected) => {
    expect(descriptions(command)[0]).toContain(expected);
  });

  it("does not mistake a language formatter for mkfs", () => {
    expect(threatsOf("pnpm format --write .")).toEqual([]);
  });
});

describe("analyzeCommand: sudo and multiple subcommands", () => {
  it("analyzes each subcommand", () => {
    expect(descriptions("cd /tmp && rm -rf ~/Documents")).toHaveLength(1);
  });

  it("keeps the pipe context for xargs even though it splits commands", () => {
    expect(descriptions("find . -name '*.log' | xargs rm")).toEqual(
      expect.arrayContaining([expect.stringContaining("xargs rm")]),
    );
  });
});

describe("analyzeCommand: 结构层带来的能力", () => {
  it("sees a deletion inside a literal sh -c script", () => {
    expect(descriptions('sh -c "rm -rf ~/Documents"')).toEqual([
      expect.stringContaining("protected path"),
    ]);
  });

  it("sees a deletion inside an eval script", () => {
    expect(descriptions('eval "rm -rf ~/Documents"')).toEqual([
      expect.stringContaining("protected path"),
    ]);
  });

  it("reads a quoted home path as a target", () => {
    expect(descriptions('rm -rf "~/Documents"')).toEqual([
      expect.stringContaining(`${HOME}/Documents`),
    ]);
  });

  it("flags xargs rm even without a pipe in the same segment", () => {
    expect(descriptions("xargs rm < list.txt")).toEqual([
      expect.stringContaining("xargs rm"),
    ]);
  });

  it("does not flag a quoted mention of a deletion as an argument", () => {
    expect(threatsOf('echo "rm -rf ~/Documents"')).toEqual([]);
  });

  it("keeps sudo escalation inside a nested script", () => {
    const [threat] = threatsOf('sh -c "sudo rm -rf ~/Documents"');
    expect(threat?.description.startsWith("[sudo] ")).toBe(true);
    expect(threat?.severity).toBe("critical");
  });
});

describe("formatThreats", () => {
  it("sorts critical first and tags the severity", () => {
    const text = formatThreats({
      threats: [
        { description: "high one", severity: "high", paths: [] },
        { description: "critical one", severity: "critical", paths: [] },
        { description: "medium one", severity: "medium", paths: [] },
      ],
    });

    expect(text.split("\n")).toEqual([
      "[CRITICAL] critical one",
      "[HIGH] high one",
      "[MEDIUM] medium one",
    ]);
  });
});
