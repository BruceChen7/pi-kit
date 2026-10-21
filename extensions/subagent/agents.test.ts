import { describe, expect, it } from "vitest";
import {
  type AgentSource,
  BUILTIN_AGENTS,
  discoverProfiles,
  FULL_TOOLS,
  findProfile,
  parseToolList,
  READONLY_TOOLS,
  toProfile,
} from "./agents.js";

const source = (
  name: string,
  content: string,
  kind: AgentSource["source"] = "project",
): AgentSource => ({ name, content, source: kind });

const frontmatter = (lines: string[]): string =>
  `---\n${lines.join("\n")}\n---\n`;

describe("parseToolList", () => {
  it("splits a comma list and strips quotes", () => {
    expect(parseToolList('"read, grep"')).toEqual(["read", "grep"]);
  });

  it("accepts bracket syntax", () => {
    expect(parseToolList("[read, grep, ls]")).toEqual(["read", "grep", "ls"]);
  });

  it("returns empty for missing or blank input", () => {
    expect(parseToolList(undefined)).toEqual([]);
    expect(parseToolList("   ")).toEqual([]);
  });
});

describe("toProfile", () => {
  it("defaults to read-only tools when frontmatter omits tools", () => {
    const profile = toProfile(
      source(
        "scout",
        `${frontmatter(["name: scout", "description: look around"])}Do it.`,
      ),
    );

    expect(profile.tools).toEqual([...READONLY_TOOLS]);
    expect(profile.prompt).toBe("Do it.");
  });

  it("keeps everything the agent may do to itself out of reach of an empty tools list", () => {
    const profile = toProfile(
      source("empty", `${frontmatter(["name: empty", "tools: "])}body`),
    );

    expect(profile.tools).toEqual([...READONLY_TOOLS]);
  });

  it("parses model, thinking and prompt mode", () => {
    const profile = toProfile(
      source(
        "worker",
        `${frontmatter([
          "name: worker",
          "tools: read, edit, bash",
          "model: deepseek/deepseek-v4-flash",
          "thinking: high",
          "promptMode: replace",
        ])}Implement it.`,
      ),
    );

    expect(profile.tools).toEqual(["read", "edit", "bash"]);
    expect(profile.model).toBe("deepseek/deepseek-v4-flash");
    expect(profile.thinking).toBe("high");
    expect(profile.promptMode).toBe("replace");
  });

  it("drops an unknown thinking level instead of passing it through", () => {
    const profile = toProfile(
      source("odd", `${frontmatter(["name: odd", "thinking: turbo"])}body`),
    );

    expect(profile.thinking).toBeUndefined();
  });

  it("falls back to the description when the body is empty", () => {
    const profile = toProfile(
      source(
        "desc",
        frontmatter(["name: desc", "description: only a description"]),
      ),
    );

    expect(profile.prompt).toBe("only a description");
  });

  it("defaults to inheriting codemode and mcp from the parent", () => {
    const profile = toProfile(
      source("plain", `${frontmatter(["name: plain"])}body`),
    );

    expect(profile.codemode).toBeUndefined();
    expect(profile.mcp).toBe("inherit");
  });

  it("reads an explicit codemode switch and mcp opt-out", () => {
    const profile = toProfile(
      source(
        "off",
        `${frontmatter(["name: off", "codemode: false", "mcp: none"])}body`,
      ),
    );

    expect(profile.codemode).toBe(false);
    expect(profile.mcp).toBe("none");
  });

  it("treats an unrecognised codemode value as inherit", () => {
    const profile = toProfile(
      source("odd", `${frontmatter(["name: odd", "codemode: maybe"])}body`),
    );

    expect(profile.codemode).toBeUndefined();
  });

  it("does not throw on a broken frontmatter block", () => {
    const profile = toProfile(
      source("broken", "---\nname: broken\nnever closed"),
    );

    expect(profile.name).toBe("broken");
    expect(profile.promptMode).toBe("append");
  });
});

describe("discoverProfiles", () => {
  it("ships the three builtin profiles", () => {
    const profiles = discoverProfiles(BUILTIN_AGENTS);

    expect(profiles.map((profile) => profile.name)).toEqual([
      "explore",
      "general",
      "reviewer",
    ]);
    expect(findProfile(profiles, "general")?.tools).toEqual([...FULL_TOOLS]);
  });

  it("lets a project agent override a builtin of the same name", () => {
    const profiles = discoverProfiles([
      ...BUILTIN_AGENTS,
      source(
        "reviewer",
        `${frontmatter(["name: reviewer", "tools: read"])}Only read.`,
        "project",
      ),
    ]);

    const reviewer = findProfile(profiles, "reviewer");
    expect(reviewer?.source).toBe("project");
    expect(reviewer?.tools).toEqual(["read"]);
    expect(reviewer?.prompt).toBe("Only read.");
  });

  it("ranks project above user above builtin regardless of input order", () => {
    const profiles = discoverProfiles([
      source(
        "dup",
        `${frontmatter(["name: dup", "tools: bash"])}project`,
        "project",
      ),
      source("dup", `${frontmatter(["name: dup", "tools: ls"])}user`, "user"),
      source(
        "dup",
        `${frontmatter(["name: dup", "tools: read"])}builtin`,
        "builtin",
      ),
    ]);

    expect(findProfile(profiles, "dup")?.tools).toEqual(["bash"]);
  });

  it("keeps the first of two same-rank duplicates", () => {
    const profiles = discoverProfiles([
      source(
        "dup",
        `${frontmatter(["name: dup", "tools: read"])}first`,
        "user",
      ),
      source(
        "dup",
        `${frontmatter(["name: dup", "tools: bash"])}second`,
        "user",
      ),
    ]);

    expect(findProfile(profiles, "dup")?.tools).toEqual(["read"]);
  });

  it("sorts by name so the picker order is stable", () => {
    const profiles = discoverProfiles([
      source("zeta", `${frontmatter(["name: zeta"])}z`),
      source("alpha", `${frontmatter(["name: alpha"])}a`),
    ]);

    expect(profiles.map((profile) => profile.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("findProfile", () => {
  it("matches case-insensitively", () => {
    const profiles = discoverProfiles(BUILTIN_AGENTS);

    expect(findProfile(profiles, "EXPLORE")?.name).toBe("explore");
  });

  it("returns undefined for an unknown name", () => {
    expect(
      findProfile(discoverProfiles(BUILTIN_AGENTS), "nope"),
    ).toBeUndefined();
  });
});
