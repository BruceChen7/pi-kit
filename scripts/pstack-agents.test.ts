import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FULL_TOOLS,
  READONLY_TOOLS,
  toProfile,
} from "../extensions/subagent/agents.js";
import { extractRouteRefs } from "./poteto-kernel-gap.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");
const GUIDANCE = path.join(REPO_ROOT, "extensions/poteto-mode/guidance.md");
const ENTRY = path.join(REPO_ROOT, "prompts/poteto.md");

const ROLES = [
  "bug-fix",
  "code",
  "hillclimb",
  "judgment",
  "perf",
  "prose",
  "review",
  "strongest",
  "verification",
];

const READ_ONLY_ROLES = ["judgment", "prose", "review"];

/** 扩展注册的工具：内置白名单之外，但仍要显式点名，防止拼错。 */
const EXTENSION_TOOLS = ["git_read"];

const KNOWN_TOOLS = new Set<string>([
  ...READONLY_TOOLS,
  ...FULL_TOOLS,
  ...EXTENSION_TOOLS,
]);

const read = (file: string) => fs.readFileSync(file, "utf8");

const profiles = ROLES.map((name) =>
  toProfile({
    name,
    content: read(path.join(AGENTS_DIR, `${name}.md`)),
    source: "project",
  }),
);

describe("agent profiles", () => {
  it("ships exactly the nine roles the guidance routes to", () => {
    expect(
      fs
        .readdirSync(AGENTS_DIR)
        .filter((name) => name.endsWith(".md"))
        .map((name) => path.basename(name, ".md"))
        .sort(),
    ).toEqual(ROLES);
  });

  it("names each profile after its file and describes it", () => {
    for (const profile of profiles) {
      expect(profile.description.trim()).not.toBe("");
      expect(profile.prompt.trim()).not.toBe("");
    }
  });

  it("only requests tools the subagent extension can grant", () => {
    for (const profile of profiles) {
      for (const tool of profile.tools) {
        expect(KNOWN_TOOLS).toContain(tool);
      }
    }
  });

  it("gives read-only roles no way to write", () => {
    for (const profile of profiles.filter((item) =>
      READ_ONLY_ROLES.includes(item.name),
    )) {
      expect(profile.tools).not.toContain("edit");
      expect(profile.tools).not.toContain("write");
      expect(profile.tools).not.toContain("bash");
    }
  });

  it("gives the review role read-only git access instead of a shell", () => {
    const review = profiles.find((item) => item.name === "review");
    expect(review?.tools).toContain("git_read");
    expect(review?.tools).not.toContain("bash");
  });

  it("keeps the verification role able to run checks but not edit", () => {
    const verification = profiles.find((item) => item.name === "verification");
    expect(verification?.tools).toContain("bash");
    expect(verification?.tools).not.toContain("edit");
    expect(verification?.tools).not.toContain("write");
  });
});

describe("guidance and entry stay in sync", () => {
  it("routes to every profile", () => {
    const guidance = read(GUIDANCE);
    for (const role of ROLES) {
      expect(guidance).toContain(`| ${role}`);
    }
  });

  it("agrees on the playbook set", () => {
    expect([...extractRouteRefs(read(GUIDANCE))].sort()).toEqual(
      [...extractRouteRefs(read(ENTRY))].sort(),
    );
  });

  it("states the same evidence sentence in both places", () => {
    const sentence = "贴命令加输出末行原文";
    expect(read(GUIDANCE)).toContain(sentence);
    expect(read(ENTRY)).toContain(sentence);
  });

  it("names both todo tools, because the active one depends on the phase", () => {
    for (const entry of [GUIDANCE, ENTRY]) {
      expect(read(entry)).toContain("act_mode_todo");
      expect(read(entry)).toContain("plan_mode_todo");
    }
  });
});
