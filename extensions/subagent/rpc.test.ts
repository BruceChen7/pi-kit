import { describe, expect, it } from "vitest";
import { admit, createState, settle } from "./core.js";
import {
  buildRunEvent,
  handleRpc,
  parseRpcRequest,
  RPC_REQUEST_CHANNEL,
  RPC_VERSION,
  rpcReplyChannel,
} from "./rpc.js";

const seeded = (status: "running" | "done" = "running") => {
  const admitted = admit(
    createState(),
    { runId: "a1", agent: "explore", task: "look", background: true },
    4,
    1000,
  ).state;
  return status === "done"
    ? settle(
        admitted,
        { runId: "a1", status: "done", resultText: "found" },
        4,
        2000,
      )
    : admitted;
};

const request = (method: string, params?: unknown) =>
  ({ version: RPC_VERSION, id: "req1", method, params }) as never;

describe("parseRpcRequest", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = parseRpcRequest({ version: 1, id: "x", method: "list" });

    expect(parsed.kind).toBe("request");
    if (parsed.kind === "request") expect(parsed.request.method).toBe("list");
  });

  it("rejects a different version", () => {
    const parsed = parseRpcRequest({ version: 2, id: "x", method: "list" });

    expect(parsed).toEqual({
      kind: "error",
      id: "x",
      error: "unsupported version 2; expected 1",
    });
  });

  it("rejects an unknown method and says what is allowed", () => {
    const parsed = parseRpcRequest({ version: 1, id: "x", method: "explode" });

    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.error).toContain('unknown method "explode"');
    }
  });

  it("rejects a non-object payload", () => {
    expect(parseRpcRequest("nope")).toEqual({
      kind: "error",
      id: "",
      error: "request must be an object",
    });
  });
});

describe("rpcReplyChannel", () => {
  it("scopes the reply to the request id", () => {
    expect(rpcReplyChannel("abc")).toBe("subagent:rpc:reply:abc");
    expect(RPC_REQUEST_CHANNEL).toBe("subagent:rpc:request");
  });
});

describe("handleRpc list and status", () => {
  it("lists every run", () => {
    const outcome = handleRpc(seeded(), request("list"));

    expect(outcome.reply.ok).toBe(true);
    expect(outcome.action).toBeUndefined();
  });

  it("reports a finished run with its result", () => {
    const outcome = handleRpc(
      seeded("done"),
      request("status", { runId: "a1" }),
    );

    expect(outcome.reply).toMatchObject({
      ok: true,
      result: { status: "done", resultText: "found" },
    });
  });

  it("fails on an unknown run without an action", () => {
    const outcome = handleRpc(seeded(), request("status", { runId: "ghost" }));

    expect(outcome.reply.ok).toBe(false);
    expect(outcome.action).toBeUndefined();
  });
});

describe("handleRpc stop and steer", () => {
  it("asks the shell to stop a running run", () => {
    const outcome = handleRpc(seeded(), request("stop", { runId: "a1" }));

    expect(outcome.reply.ok).toBe(true);
    expect(outcome.action).toEqual({ kind: "stop", runId: "a1" });
  });

  it("refuses to stop an already terminal run", () => {
    const outcome = handleRpc(seeded("done"), request("stop", { runId: "a1" }));

    expect(outcome.reply).toMatchObject({ ok: false });
    expect(outcome.action).toBeUndefined();
  });

  it("asks the shell to steer a running run", () => {
    const outcome = handleRpc(
      seeded(),
      request("steer", { runId: "a1", text: "narrow it" }),
    );

    expect(outcome.action).toEqual({
      kind: "steer",
      runId: "a1",
      text: "narrow it",
    });
  });

  it("refuses to steer a finished run and produces no side effect", () => {
    const outcome = handleRpc(
      seeded("done"),
      request("steer", { runId: "a1", text: "again" }),
    );

    expect(outcome.reply).toMatchObject({ ok: false });
    expect(outcome.action).toBeUndefined();
  });

  it("requires steer text", () => {
    const outcome = handleRpc(
      seeded(),
      request("steer", { runId: "a1", text: "   " }),
    );

    expect(outcome.reply).toMatchObject({ ok: false });
    expect(outcome.action).toBeUndefined();
  });
});

describe("handleRpc run", () => {
  it("asks the shell to start a run and defaults to background", () => {
    const outcome = handleRpc(seeded(), request("run", { task: "count dirs" }));

    expect(outcome.action).toEqual({
      kind: "run",
      agent: undefined,
      task: "count dirs",
      background: true,
    });
  });

  it("requires a task", () => {
    const outcome = handleRpc(seeded(), request("run", { agent: "explore" }));

    expect(outcome.reply).toMatchObject({ ok: false });
    expect(outcome.action).toBeUndefined();
  });
});

describe("buildRunEvent", () => {
  it("carries the version and the run identity", () => {
    expect(
      buildRunEvent({
        event: "settled",
        runId: "a1",
        agent: "explore",
        status: "done",
      }),
    ).toEqual({
      version: 1,
      event: "settled",
      runId: "a1",
      agent: "explore",
      status: "done",
    });
  });
});
