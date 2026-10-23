import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRouteRefs } from "../../scripts/poteto-kernel-gap.mjs";
import {
  buildInjection,
  PLAYBOOK_DIR_TOKEN,
  POTETO_OFF_NOTICE,
  renderGuidance,
} from "./guidance.js";

const body = readFileSync(new URL("./guidance.md", import.meta.url), "utf8");

const ROLES = [
  "code",
  "bug-fix",
  "perf",
  "hillclimb",
  "judgment",
  "strongest",
  "review",
  "prose",
  "verification",
];

describe("buildInjection", () => {
  it("injects nothing when the branch never set a mode", () => {
    expect(buildInjection({ enabled: false, explicit: false }, body)).toBe("");
    expect(buildInjection({ enabled: true, explicit: false }, body)).toBe("");
  });

  it("injects the body when enabled", () => {
    expect(buildInjection({ enabled: true, explicit: true }, body)).toBe(body);
  });

  it("injects the off notice when explicitly disabled", () => {
    expect(buildInjection({ enabled: false, explicit: true }, body)).toBe(
      POTETO_OFF_NOTICE,
    );
    expect(POTETO_OFF_NOTICE).toContain("早先的自动模式提醒不再适用");
  });
});

describe("renderGuidance", () => {
  it("replaces every playbook token with the install location", () => {
    const rendered = renderGuidance(body, "/opt/pi-kit/skills/playbooks/");
    expect(rendered).not.toContain(PLAYBOOK_DIR_TOKEN);
    expect(rendered).toContain("/opt/pi-kit/skills/playbooks/<name>.md");
  });

  it("leaves text without the token untouched", () => {
    expect(renderGuidance("no token here", "/x")).toBe("no token here");
  });
});

describe("guidance.md contract", () => {
  it("keeps the five sections the injection promises", () => {
    for (const heading of [
      "路由",
      "证据",
      "委派",
      "暂停线",
      "与 plan-mode 的关系",
    ]) {
      expect(body).toContain(`## ${heading}`);
    }
  });

  it("names every role the profiles define", () => {
    for (const role of ROLES) {
      expect(body).toContain(`| ${role}`);
    }
  });

  it("routes to every vendored playbook and nothing else", () => {
    expect([...extractRouteRefs(body)].sort()).toEqual([
      "autonomous-run",
      "feature",
      "pause-safely",
      "perf-issue",
      "refactoring",
      "runtime-forensics",
      "trace-forensics",
    ]);
  });

  it("states the evidence contract with a quotable output line", () => {
    expect(body).toContain("贴命令加输出末行原文");
    expect(body).toContain("推断");
    expect(body).toContain("猜");
  });

  it("leaves the plan gate to plan-mode and names both todo tools", () => {
    expect(body).toContain("由 plan-mode 管");
    expect(body).toContain("act_mode_todo");
    expect(body).toContain("plan_mode_todo");
  });

  it("uses no long dash", () => {
    expect(body).not.toMatch(/[—–]/);
  });
});
