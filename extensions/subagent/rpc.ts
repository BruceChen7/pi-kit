/**
 * 跨扩展 RPC（Functional Core）。
 *
 * pi.events 是裸的 pub/sub，没有请求-响应配套，所以这里自己定一个最小信封：
 * 请求发到固定频道，回复发到 `subagent:rpc:reply:<id>`。
 *
 * Core 只**描述**要做什么（`RpcOutcome.action`），不执行任何副作用 ——
 * 这样"非法请求不产生副作用"可以被测试断言。
 */

import {
  findRun,
  isTerminal,
  type RunStatus,
  type SubagentState,
} from "./core.ts";

export const RPC_REQUEST_CHANNEL = "subagent:rpc:request";
export const RPC_EVENT_CHANNEL = "subagent:run";
export const RPC_VERSION = 1;

export type RpcMethod = "list" | "status" | "run" | "stop" | "steer";

const METHODS: readonly RpcMethod[] = [
  "list",
  "status",
  "run",
  "stop",
  "steer",
];

export type RpcRequest = {
  version: 1;
  id: string;
  method: RpcMethod;
  params?: unknown;
};

export type RpcReply =
  | { version: 1; id: string; ok: true; result: unknown }
  | { version: 1; id: string; ok: false; error: string };

export type RpcAction =
  | { kind: "run"; agent?: string; task: string; background: boolean }
  | { kind: "stop"; runId: string }
  | { kind: "steer"; runId: string; text: string };

export type RunEventInput = {
  event: "started" | "settled" | "steered";
  runId: string;
  agent: string;
  status?: RunStatus;
};

/** 运行事件信封。带 `status` 的只有 settled，其余事件不写这个字段。 */
export type RunEvent = RunEventInput & { version: 1 };

export type RpcOutcome = {
  reply: RpcReply;
  action?: RpcAction;
};

export const rpcReplyChannel = (id: string): string =>
  `${RPC_REQUEST_CHANNEL.replace(":request", ":reply")}:${id}`;

const fail = (id: string, error: string): RpcOutcome => ({
  reply: { version: 1, id, ok: false, error },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isRpcMethod = (value: string): value is RpcMethod =>
  METHODS.some((method) => method === value);

/** 只认布尔，其它类型（包括 "false"）一律回落到默认值。 */
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** 解析并校验一个请求信封。非法输入不抛错，返回可回传的错误。 */
export type ParsedRpcRequest =
  | { kind: "request"; request: RpcRequest }
  | { kind: "error"; id: string; error: string };

export function parseRpcRequest(raw: unknown): ParsedRpcRequest {
  if (!isRecord(raw))
    return { kind: "error", id: "", error: "request must be an object" };

  const id = asText(raw.id);
  if (!id) return { kind: "error", id: "", error: "request.id is required" };

  if (raw.version !== RPC_VERSION) {
    return {
      kind: "error",
      id,
      error: `unsupported version ${String(raw.version)}; expected ${RPC_VERSION}`,
    };
  }

  const method = asText(raw.method);
  if (!method || !isRpcMethod(method)) {
    return {
      kind: "error",
      id,
      error: `unknown method "${method ?? ""}"; expected one of ${METHODS.join(", ")}`,
    };
  }

  return {
    kind: "request",
    request: {
      version: RPC_VERSION,
      id,
      method,
      params: raw.params,
    },
  };
}

/**
 * 纯分派：读 state → 决定 reply，需要副作用时返回 action 交给 Shell。
 * 任何非法参数都回 `ok:false` 且不带 action。
 */
export function handleRpc(
  state: SubagentState,
  request: RpcRequest,
): RpcOutcome {
  const params = isRecord(request.params) ? request.params : undefined;
  const reply = (result: unknown): RpcOutcome => ({
    reply: { version: 1, id: request.id, ok: true, result },
  });
  const runId = asText(params?.runId);

  switch (request.method) {
    case "list":
      return reply({
        runs: state.runs.map((run) => ({
          runId: run.runId,
          agent: run.agent,
          status: run.status,
          step: run.step,
          background: run.background,
        })),
      });

    case "status": {
      if (!runId) return fail(request.id, "status requires params.runId");
      const run = findRun(state, runId);
      if (!run) return fail(request.id, `unknown run "${runId}"`);
      return reply({
        runId: run.runId,
        agent: run.agent,
        status: run.status,
        resultText: run.resultText ?? null,
        error: run.error ?? null,
      });
    }

    case "stop": {
      if (!runId) return fail(request.id, "stop requires params.runId");
      const run = findRun(state, runId);
      if (!run) return fail(request.id, `unknown run "${runId}"`);
      if (isTerminal(run.status)) {
        return fail(request.id, `run "${runId}" already ${run.status}`);
      }
      return {
        ...reply({ runId, stopped: true }),
        action: { kind: "stop", runId },
      };
    }

    case "steer": {
      if (!runId) return fail(request.id, "steer requires params.runId");
      const text = asText(params?.text);
      if (!text) return fail(request.id, "steer requires params.text");
      const run = findRun(state, runId);
      if (!run) return fail(request.id, `unknown run "${runId}"`);
      if (isTerminal(run.status) || run.status === "queued") {
        return fail(
          request.id,
          `run "${runId}" is ${run.status}; nothing to steer`,
        );
      }
      return {
        ...reply({ runId, steered: true }),
        action: { kind: "steer", runId, text },
      };
    }

    case "run": {
      const task = asText(params?.task);
      if (!task) return fail(request.id, "run requires params.task");
      const agent = asText(params?.agent);
      return {
        ...reply({ accepted: true, agent: agent ?? "general" }),
        action: {
          kind: "run",
          agent,
          task,
          background: asBoolean(params?.background) ?? true,
        },
      };
    }

    default: {
      const unhandled: never = request.method;
      return fail(request.id, `unhandled method ${String(unhandled)}`);
    }
  }
}

/** 广播事件的信封（started / settled / steered）。 */
export function buildRunEvent(input: RunEventInput): RunEvent {
  return input.status === undefined
    ? { version: RPC_VERSION, ...input }
    : { version: RPC_VERSION, ...input, status: input.status };
}
