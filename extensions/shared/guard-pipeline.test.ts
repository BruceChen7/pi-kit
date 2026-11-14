import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateVerdicts,
  ask,
  deny,
  evaluateGuards,
  formatBlockReason,
  type GuardEnv,
  type GuardStage,
  installGuardPipeline,
  MAX_GUARD_TEXT_LENGTH,
  oversizedVerdict,
  PASS,
  readGuardCall,
  registeredGuards,
  registerGuard,
  resetGuardPipeline,
  toToolCallResult,
} from "./guard-pipeline.ts";

const env = (overrides: Partial<GuardEnv> = {}): GuardEnv => ({
  cwd: "/repo",
  hasUI: true,
  env: {},
  ctx: {} as GuardEnv["ctx"],
  ...overrides,
});

const stage = (
  id: string,
  kind: "deny" | "ask",
  evaluate: GuardStage["evaluate"],
): GuardStage => ({ id, kind, evaluate });

const bashCall = (command: string) => readGuardCall("bash", { command });

// ── aggregateVerdicts ────────────────────────────────────────

describe("aggregateVerdicts", () => {
  it("passes when nothing blocks", () => {
    expect(aggregateVerdicts([PASS, PASS])).toEqual({ action: "pass" });
    expect(aggregateVerdicts([])).toEqual({ action: "pass" });
  });

  it("lets a deny beat an ask", () => {
    const aggregate = aggregateVerdicts([ask("a", "ask"), deny("d", "deny")]);

    expect(aggregate).toMatchObject({ action: "block", kind: "deny" });
    expect(aggregate.action === "block" && aggregate.blocks).toHaveLength(1);
  });

  it("collects every deny and keeps registration order", () => {
    const aggregate = aggregateVerdicts([
      deny("first", "r1"),
      PASS,
      deny("second", "r2"),
    ]);

    expect(aggregate).toMatchObject({
      action: "block",
      kind: "deny",
      blocks: [
        { rule: "first", reason: "r1" },
        { rule: "second", reason: "r2" },
      ],
    });
  });

  it("reports one rule once even when several stages hit it", () => {
    const aggregate = aggregateVerdicts([
      deny("same", "r1"),
      deny("same", "r2"),
    ]);

    expect(aggregate.action === "block" && aggregate.blocks).toEqual([
      { rule: "same", reason: "r1" },
    ]);
  });

  it("reports a single ask when no deny fired", () => {
    const aggregate = aggregateVerdicts([
      ask("confirm", "r"),
      ask("other", "r"),
    ]);

    expect(aggregate).toMatchObject({
      action: "block",
      kind: "ask",
      blocks: [{ rule: "confirm" }],
    });
  });
});

// ── formatting ──────────────────────────────────────────────

describe("formatBlockReason / toToolCallResult", () => {
  it("names the tool, the tier, and every rule", () => {
    const reason = formatBlockReason(
      "bash",
      aggregateVerdicts([deny("sleep", "等太久了"), deny("loop", "别循环")]),
    );

    expect(reason).toContain("bash");
    expect(reason).toContain("deny");
    expect(reason).toContain("loop, sleep");
    expect(reason).toContain("等太久了");
    expect(reason).toContain("别循环");
  });

  it("returns undefined instead of a block for a pass", () => {
    expect(toToolCallResult("bash", { action: "pass" })).toBeUndefined();
  });
});

// ── oversized input ─────────────────────────────────────────

describe("oversizedVerdict", () => {
  it("passes a call at the limit", () => {
    expect(
      oversizedVerdict(bashCall("x".repeat(MAX_GUARD_TEXT_LENGTH))),
    ).toEqual(PASS);
  });

  it("fails closed one character over the limit", () => {
    const verdict = oversizedVerdict(
      bashCall("x".repeat(MAX_GUARD_TEXT_LENGTH + 1)),
    );

    expect(verdict).toMatchObject({ action: "block", rule: "input-too-large" });
  });

  it("only measures the bash command, not other tool payloads", () => {
    const call = readGuardCall("write", { content: "x".repeat(2_000_000) });

    expect(oversizedVerdict(call)).toEqual(PASS);
  });
});

// ── evaluateGuards ──────────────────────────────────────────

describe("evaluateGuards", () => {
  beforeEach(() => {
    resetGuardPipeline();
  });

  it("does not depend on registration order", async () => {
    const a = stage("a", "deny", () => deny("a-rule", "a"));
    const b = stage("b", "deny", () => deny("b-rule", "b"));

    registerGuard(a);
    registerGuard(b);
    const first = await evaluateGuards(bashCall("cmd"), env());

    resetGuardPipeline();
    registerGuard(b);
    registerGuard(a);
    const second = await evaluateGuards(bashCall("cmd"), env());

    expect(first.action === "block" && first.blocks.map((x) => x.rule)).toEqual(
      ["a-rule", "b-rule"],
    );
    expect(
      second.action === "block" && second.blocks.map((x) => x.rule),
    ).toEqual(["a-rule", "b-rule"]);
  });

  it("skips ask stages once a deny fired", async () => {
    const asked = vi.fn(() => ask("confirm", "r"));
    registerGuard(stage("deny", "deny", () => deny("no", "nope")));
    registerGuard(stage("ask", "ask", asked));

    const aggregate = await evaluateGuards(bashCall("cmd"), env());

    expect(aggregate).toMatchObject({ action: "block", kind: "deny" });
    expect(asked).not.toHaveBeenCalled();
  });

  it("runs ask stages when no deny fired", async () => {
    registerGuard(stage("deny", "deny", () => PASS));
    registerGuard(stage("ask", "ask", () => ask("confirm", "r")));

    expect(await evaluateGuards(bashCall("cmd"), env())).toMatchObject({
      action: "block",
      kind: "ask",
    });
  });

  it("fails closed when a stage throws", async () => {
    registerGuard(
      stage("boom", "deny", () => {
        throw new Error("解析失败");
      }),
    );

    const aggregate = await evaluateGuards(bashCall("cmd"), env());

    expect(aggregate).toMatchObject({ action: "block", kind: "deny" });
    expect(aggregate.action === "block" && aggregate.blocks[0]?.rule).toBe(
      "stage-error:boom",
    );
  });

  it("keeps one stage per id across reloads", () => {
    registerGuard(stage("dup", "deny", () => PASS));
    registerGuard(stage("dup", "deny", () => PASS));

    expect(registeredGuards().filter((s) => s.id === "dup")).toHaveLength(1);
  });
});

// ── shell ───────────────────────────────────────────────────

describe("installGuardPipeline", () => {
  beforeEach(() => {
    resetGuardPipeline();
  });

  const fakePi = () => {
    const handlers: Array<
      (
        event: { toolName: string; input: unknown },
        ctx: unknown,
      ) => Promise<{ block: true; reason: string } | undefined>
    > = [];
    const pi = {
      on: (name: string, handler: unknown) => {
        if (name === "tool_call") {
          handlers.push(handler as (typeof handlers)[number]);
        }
      },
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  };

  it("installs one handler however many extensions ask for it", () => {
    const { pi, handlers } = fakePi();

    installGuardPipeline(pi);
    installGuardPipeline(pi);

    expect(handlers).toHaveLength(1);
  });

  it("returns the merged reason for a blocked call", async () => {
    const { pi, handlers } = fakePi();
    registerGuard(stage("guard-a", "deny", () => deny("a", "原因 A")));
    registerGuard(stage("guard-b", "deny", () => deny("b", "原因 B")));
    installGuardPipeline(pi);

    const result = await handlers[0]?.(
      { toolName: "bash", input: { command: "rm -rf /" } },
      { cwd: "/repo", hasUI: true },
    );

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("原因 A");
    expect(result?.reason).toContain("原因 B");
  });

  it("lets a passing call through untouched", async () => {
    const { pi, handlers } = fakePi();
    registerGuard(stage("guard-a", "deny", () => PASS));
    installGuardPipeline(pi);

    const result = await handlers[0]?.(
      { toolName: "read", input: { path: "/repo/a.ts" } },
      { cwd: "/repo", hasUI: false },
    );

    expect(result).toBeUndefined();
  });
});
