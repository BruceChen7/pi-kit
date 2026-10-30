import { describe, expect, it } from "vitest";
import {
  type BashCall,
  type BashGuardLimits,
  DEFAULT_MAX_SECONDS,
  decideBashGuard,
  readBashCall,
  resolveLimits,
} from "./guard.js";
import bashBlockGuard, { createBashGuardHandler } from "./index.js";

const limits = (overrides: Partial<BashGuardLimits> = {}): BashGuardLimits => ({
  maxSeconds: DEFAULT_MAX_SECONDS,
  enabled: true,
  ...overrides,
});

const decide = (call: BashCall, overrides?: Partial<BashGuardLimits>) =>
  decideBashGuard(call, limits(overrides));

// ── sleep ────────────────────────────────────────────────────

describe("decideBashGuard: sleep", () => {
  it("blocks a sleep at the threshold", () => {
    expect(decide({ command: "sleep 20" })).toMatchObject({
      action: "block",
      rule: "sleep",
    });
  });

  it("reads the unit suffix as seconds", () => {
    expect(decide({ command: "sleep 1m" })).toMatchObject({ rule: "sleep" });
    expect(decide({ command: "sleep 10s" })).toEqual({ action: "allow" });
  });

  it("blocks a longer sleep and names the seconds", () => {
    const decision = decide({ command: "sleep 300" });

    expect(decision).toMatchObject({ action: "block", rule: "sleep" });
    expect(decision.action === "block" && decision.reason).toContain("300");
  });

  it("allows a short sleep", () => {
    expect(decide({ command: "sleep 5" })).toEqual({ action: "allow" });
  });

  it("allows a fraction below the threshold", () => {
    expect(decide({ command: "sleep 0.5" })).toEqual({ action: "allow" });
  });

  it("blocks a sleep chained after other work", () => {
    expect(decide({ command: "sleep 30 && echo done" })).toMatchObject({
      rule: "sleep",
    });
  });

  it("ignores a sleep inside double quotes", () => {
    expect(decide({ command: 'echo "sleep 30"' })).toEqual({
      action: "allow",
    });
  });

  it("ignores a sleep inside single quotes", () => {
    expect(decide({ command: "printf '%s' 'sleep 30'" })).toEqual({
      action: "allow",
    });
  });

  it("ignores a sleep only mentioned in a comment", () => {
    expect(decide({ command: "# sleep 30\necho done" })).toEqual({
      action: "allow",
    });
  });
});

// ── sleep-loop ───────────────────────────────────────────────

describe("decideBashGuard: sleep loop", () => {
  it("blocks the polling loop from the session that motivated this", () => {
    expect(
      decide({
        command:
          "for i in $(seq 1 50); do glab ci status | head -3; sleep 20; done",
      }),
    ).toMatchObject({ action: "block", rule: "sleep-loop" });
  });

  it("blocks a while loop even when each sleep is short", () => {
    expect(
      decide({ command: "while true; do curl -s x; sleep 1; done" }),
    ).toMatchObject({ rule: "sleep-loop" });
  });

  it("blocks an until loop", () => {
    expect(
      decide({ command: "until [ -f /tmp/x ]; do sleep 2; done" }),
    ).toMatchObject({ rule: "sleep-loop" });
  });

  it("names the longest wait in the reason", () => {
    const decision = decide({
      command: "for i in 1 2 3; do sleep 15; sleep 45; done",
    });

    expect(decision.action === "block" && decision.reason).toContain("45");
  });

  it("allows a loop that does not sleep", () => {
    expect(decide({ command: "for f in *.ts; do echo $f; done" })).toEqual({
      action: "allow",
    });
  });

  it("allows the word for outside a loop", () => {
    expect(decide({ command: "echo ready for review" })).toEqual({
      action: "allow",
    });
  });

  it("does not read a search for the word sleep as a sleep call", () => {
    expect(
      decide({ command: 'while read -r f; do grep -l sleep "$f"; done' }),
    ).toEqual({ action: "allow" });
    expect(decide({ command: "ls sleep.txt" })).toEqual({ action: "allow" });
  });
});

// ── what is not part of this call ────────────────────────────

describe("decideBashGuard: bodies and blind spots", () => {
  it("does not read a heredoc body as something that runs", () => {
    const command = [
      "cat > /tmp/poll.sh <<'EOF'",
      "for i in $(seq 1 50); do",
      "  glab ci status",
      "  sleep 20",
      "done",
      "EOF",
      "sh /tmp/poll.sh",
    ].join("\n");

    expect(decide({ command })).toEqual({ action: "allow" });
  });

  it("treats # after a separator as a comment", () => {
    expect(decide({ command: "echo hi;# sleep 30" })).toEqual({
      action: "allow",
    });
  });

  it("does not quote away an unterminated quote", () => {
    expect(decide({ command: 'echo "unclosed then sleep 30' })).toMatchObject({
      rule: "sleep",
    });
  });

  it("accepts the documented blind spot of a wait inside sh -c", () => {
    // Quotes are stripped before scanning, so this slips through on purpose.
    // Changing that would start blocking `echo "sleep 30"`.
    expect(decide({ command: 'sh -c "sleep 30"' })).toEqual({
      action: "allow",
    });
  });
});

// ── long-timeout ─────────────────────────────────────────────

describe("decideBashGuard: long timeout", () => {
  it("blocks a call that asks pi to wait past the limit", () => {
    expect(
      decide({ command: "docker build .", timeoutSeconds: 600 }),
    ).toMatchObject({ action: "block", rule: "long-timeout" });
  });

  it("allows a call at the limit", () => {
    expect(decide({ command: "docker build .", timeoutSeconds: 300 })).toEqual({
      action: "allow",
    });
  });

  it("does not read the CLI timeout command as the tool timeout", () => {
    expect(decide({ command: "timeout 600 docker build ." })).toEqual({
      action: "allow",
    });
  });

  it("mentions the limit and the override in the reason", () => {
    const decision = decide({ command: "make build", timeoutSeconds: 900 });

    if (decision.action !== "block") {
      throw new Error("expected a block");
    }
    expect(decision.reason).toContain("900");
    expect(decision.reason).toContain("PI_BASH_GUARD_MAX_SECONDS");
  });

  it("writes the caller's own command into the background rewrite", () => {
    const decision = decide({
      command: "npx vitest run extensions/plan-mode",
      timeoutSeconds: 1800,
    });

    if (decision.action !== "block") {
      throw new Error("expected a block");
    }
    // 实录：11 次拦截里 agent 都要自己把 <cmd> / <slug> 填出来，多花一轮。
    expect(decision.reason).toContain(
      "npx vitest run extensions/plan-mode > /tmp/",
    );
    expect(decision.reason).toContain("2>&1 &");
    expect(decision.reason).toContain("vitest-run");
    expect(decision.reason).not.toContain("<cmd>");
  });

  it("turns a sleep loop into one concrete query", () => {
    const decision = decide({
      command:
        "for i in 1 2 3; do glab ci status --branch main | head -5; sleep 30; done",
    });

    if (decision.action !== "block") {
      throw new Error("expected a block");
    }
    expect(decision.reason).toContain(
      "timeout 30 glab ci status --branch main | head -5",
    );
  });
});

// ── limits ───────────────────────────────────────────────────

describe("limits", () => {
  it("defaults to 300 seconds and enabled", () => {
    expect(resolveLimits({})).toEqual({
      maxSeconds: DEFAULT_MAX_SECONDS,
      enabled: true,
    });
  });

  it("lets a configured limit through a long call", () => {
    const resolved = resolveLimits({ PI_BASH_GUARD_MAX_SECONDS: "900" });

    expect(
      decideBashGuard({ command: "make build", timeoutSeconds: 600 }, resolved),
    ).toEqual({ action: "allow" });
  });

  it("ignores an unusable limit value", () => {
    expect(
      resolveLimits({ PI_BASH_GUARD_MAX_SECONDS: "soon" }).maxSeconds,
    ).toBe(DEFAULT_MAX_SECONDS);
  });

  it("turns every rule off when disabled", () => {
    const resolved = resolveLimits({ PI_BASH_GUARD_DISABLED: "1" });

    expect(
      decideBashGuard(
        { command: "for i in 1 2; do sleep 60; done", timeoutSeconds: 900 },
        resolved,
      ),
    ).toEqual({ action: "allow" });
  });
});

// ── reading the tool call ────────────────────────────────────

describe("readBashCall", () => {
  it("reads command and timeout from a bash call", () => {
    expect(readBashCall("bash", { command: "ls", timeout: 30 })).toEqual({
      command: "ls",
      timeoutSeconds: 30,
    });
  });

  it("leaves the timeout undefined when absent", () => {
    expect(readBashCall("bash", { command: "ls" })).toEqual({
      command: "ls",
      timeoutSeconds: undefined,
    });
  });

  it("ignores other tools and unusable input", () => {
    expect(readBashCall("read", { command: "ls" })).toBeNull();
    expect(readBashCall("bash", {})).toBeNull();
    expect(readBashCall("bash", { command: "   " })).toBeNull();
    expect(readBashCall("bash", null)).toBeNull();
  });
});

// ── the extension as pi drives it ────────────────────────────

describe("tool_call hook", () => {
  const handler = createBashGuardHandler({});
  const call = (command: string, timeout?: number) =>
    handler({ toolName: "bash", input: { command, timeout } });

  // The six cases the plan's completion condition names.
  it("blocks sleep 30", () => {
    expect(call("sleep 30")).toMatchObject({ block: true });
  });

  it("blocks a loop whose sleeps are short", () => {
    expect(call("for i in 1 2 3; do sleep 5; done")).toMatchObject({
      block: true,
    });
  });

  it("blocks a 600 second call", () => {
    expect(call("make build", 600)).toMatchObject({ block: true });
  });

  it("lets a short sleep run", () => {
    expect(call("sleep 5")).toBeUndefined();
  });

  it("lets a quoted sleep run", () => {
    expect(call('echo "sleep 30"')).toBeUndefined();
  });

  it("lets a 200 second call run", () => {
    expect(call("docker build .", 200)).toBeUndefined();
  });

  it("carries the replacement move into the reason", () => {
    const result = call(
      "for i in $(seq 1 50); do glab ci status; sleep 20; done",
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("替代写法");
  });

  it("blocks the 1100 second poll from the session that motivated this", () => {
    expect(call("glab ci status", 1100)).toMatchObject({ block: true });
  });

  it("returns nothing for tools the guard does not own", () => {
    expect(
      handler({ toolName: "write", input: { command: "sleep 30" } }),
    ).toBeUndefined();
  });

  it("reads the environment when the extension is created for production", () => {
    const disarmed = createBashGuardHandler({ PI_BASH_GUARD_DISABLED: "1" });

    expect(
      disarmed({ toolName: "bash", input: { command: "sleep 60" } }),
    ).toBeUndefined();
  });
});

describe("registration", () => {
  type Handler = (event: { toolName: string; input: unknown }) => unknown;

  it("subscribes the guard to tool_call through pi.on", () => {
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on: (name: string, handler: Handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };

    bashBlockGuard(pi as unknown as Parameters<typeof bashBlockGuard>[0]);

    const registered = handlers.get("tool_call") ?? [];
    expect(registered).toHaveLength(1);
    const [handler] = registered;
    expect(
      handler?.({ toolName: "bash", input: { command: "sleep 60" } }),
    ).toMatchObject({ block: true });
    expect(
      handler?.({ toolName: "bash", input: { command: "ls" } }),
    ).toBeUndefined();
  });
});
