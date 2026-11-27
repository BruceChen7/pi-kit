import { describe, expect, it } from "vitest";
import { type BashGuardLimits, decideBashGuard } from "./guard.js";

const limits: BashGuardLimits = { enabled: true, maxSeconds: 300 };
const decide = (command: string, timeoutSeconds?: number) =>
  decideBashGuard({ command, timeoutSeconds }, limits);

/**
 * Commands copied from the 2026-11-26/27 sessions. They are the exact shapes
 * the text scanner blocked and an AST guard must get right.
 */
describe("session corpus: bounded polling with output", () => {
  it("allows the doop health poll (11-26T08:27Z)", () => {
    const command = [
      "make -C doop-docker start-hiragino 2>&1 | tail -10;",
      "echo '--- wait health ---';",
      "for i in $(seq 1 20); do",
      '  if curl -fsS http://localhost:4300/healthz >/dev/null 2>&1; then echo "healthy on try $i"; break; fi;',
      "  sleep 1;",
      "done;",
      "curl -fsS http://localhost:4300/healthz",
    ].join(" ");

    expect(decide(command)).toEqual({ action: "allow" });
  });

  it("allows the ps/awk memory poll (11-27T03:35Z)", () => {
    const command =
      "for i in $(seq 1 10); do ps -o pid=,rss=,command= -p 52176 | awk '{print $1, $2\"KB\", $3}'; sleep 1; done";

    expect(decide(command)).toEqual({ action: "allow" });
  });

  it("allows the bounded 0.3s wheel probe after a heredoc (11-26T02:31Z)", () => {
    const lines = [
      "python3 - <<'PY'",
      "s = open('/tmp/postwheel.swift').read()",
      "PY",
      "for i in $(seq 1 30); do grep -q 'viewer open' /tmp/wheelprobe.log && break; sleep 0.3; done;",
      "tail -5 /tmp/wheelprobe.log",
    ];

    expect(decide(lines.join("\n"))).toEqual({ action: "allow" });
  });

  it("allows a short bounded loop that prints progress", () => {
    expect(decide('for i in 1 2 3; do echo "try $i"; sleep 1; done')).toEqual({
      action: "allow",
    });
  });
});

describe("session corpus: real waits still block", () => {
  it("blocks the 20s CI poll that motivated the guard", () => {
    const decision = decide(
      "for i in $(seq 1 50); do glab ci status | head -3; sleep 20; done",
    );
    expect(decision).toMatchObject({ action: "block", rule: "sleep-loop" });
  });

  it("blocks a loop whose body only sleeps", () => {
    expect(decide("until [ -f /tmp/x ]; do sleep 2; done")).toMatchObject({
      action: "block",
      rule: "sleep-loop",
    });
  });

  it("blocks the same loop behind cd &&", () => {
    const decision = decide(
      "cd /repo && for i in 1 2 3; do glab ci status --branch main | head -5; sleep 30; done",
    );
    expect(decision).toMatchObject({ action: "block", rule: "sleep-loop" });
  });

  it("blocks a sleep loop inside sh -c", () => {
    expect(decide('sh -c "for i in 1 2; do sleep 30; done"')).toMatchObject({
      action: "block",
      rule: "sleep-loop",
    });
  });

  it("blocks a bare 20s sleep", () => {
    expect(decide("sleep 20")).toMatchObject({
      action: "block",
      rule: "sleep",
    });
  });
});

describe("session corpus: declared timeout is an upper bound, not a wait", () => {
  it("allows a 400s tool timeout on commit + push (11-27T04:11Z)", () => {
    const command = [
      "cd /Users/ming.chen/work/pi-kit &&",
      "git add scripts/install-plugins.test.ts &&",
      "git commit -m 'fix(test): use real node in install-plugins test env @pi' &&",
      "git push origin master 2>&1 | tail -25;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter from the session
      'echo "push_exit=${PIPESTATUS[0]}"',
    ].join(" ");

    expect(decide(command, 400)).toEqual({ action: "allow" });
  });

  it("allows a 600s tool timeout on a streaming test command", () => {
    expect(decide("npm test | tail -30", 600)).toEqual({ action: "allow" });
  });

  it("blocks a long timeout whose output is already captured to a file", () => {
    expect(decide("make check > /tmp/make-check.log 2>&1", 900)).toMatchObject({
      action: "block",
      rule: "long-timeout",
    });
  });

  it("still blocks sleep regardless of the declared timeout", () => {
    expect(decide("sleep 300", 600)).toMatchObject({
      action: "block",
      rule: "sleep",
    });
  });
});

describe("wrappers must not hide a wait", () => {
  const waitingShell = "while :; do sleep 30; done";

  it("expands sudo bash -c", () => {
    expect(decide(`sudo bash -c '${waitingShell}'`)).toMatchObject({
      action: "block",
      rule: "sleep-loop",
    });
  });

  it("expands xargs bash -c", () => {
    expect(decide(`xargs -0 bash -c '${waitingShell}'`)).toMatchObject({
      action: "block",
      rule: "sleep-loop",
    });
  });

  it("expands env and nice before a shell payload", () => {
    expect(decide("env FOO=1 bash -c 'sleep 30'")).toMatchObject({
      action: "block",
      rule: "sleep",
    });
    expect(decide(`nice -n 5 bash -c '${waitingShell}'`)).toMatchObject({
      rule: "sleep-loop",
    });
  });

  it("expands chained wrappers", () => {
    expect(decide(`timeout 5 sudo bash -c '${waitingShell}'`)).toMatchObject({
      rule: "sleep-loop",
    });
  });

  it("expands find -exec", () => {
    expect(
      decide(`find . -name x -exec sh -c '${waitingShell}' {} \\;`),
    ).toMatchObject({ action: "block", rule: "sleep-loop" });
  });

  it("expands literal eval payloads and fails closed on dynamic ones", () => {
    expect(decide('eval "sleep 30"')).toMatchObject({
      action: "block",
      rule: "sleep",
    });
    expect(decide('eval "$CMD"')).toMatchObject({
      action: "block",
      rule: "unparseable",
    });
  });

  it("leaves ordinary wrapper calls alone", () => {
    expect(decide("sudo ls /tmp")).toEqual({ action: "allow" });
    expect(decide("env FOO=1 echo hi")).toEqual({ action: "allow" });
  });
});

describe("reason text", () => {
  it("keeps the wait-log template but never invents a concrete rewrite", () => {
    const decision = decide(
      "for i in 1 2 3; do glab ci status --branch main | head -5; sleep 30; done",
    );
    if (decision.action !== "block") throw new Error("expected a block");

    expect(decision.reason).toContain("tools/wait-log.sh");
    expect(decision.reason).not.toContain("改法（具体到你这条命令）");
    expect(decision.reason).not.toContain("timeout 30 glab");
  });
});
