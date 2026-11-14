/**
 * 一次工具调用可能有不止一个护栏要说"不"。这个模块把它们收成一条显式排序的
 * 流水线，取代"每个扩展各挂一个 tool_call、谁先注册谁生效"的现状（ADR-0001 D1）。
 *
 * 顺序：deny 阶段全部跑完 → 有 deny 就不跑 ask 阶段 → ask 阶段按注册顺序，
 * 第一个拦下的生效。聚合规则是 deny 恒胜 ask，ask 恒胜放行。
 *
 * Core 是纯的：aggregateVerdicts / formatBlockReason / oversizedVerdict 都是
 * 输入值到输出值。Shell 只有一个 pi.on("tool_call")，把判决翻成 pi 的返回值。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** 一个护栏说话的分量。deny 不能被任何 ask 或放行盖掉。 */
export type GuardKind = "deny" | "ask";

/** 交给护栏的那次调用。`text` 是用于长度上限的主参数文本（目前只有 bash 命令）。 */
export type GuardCall = {
  toolName: string;
  input: unknown;
  text: string;
};

/** 护栏需要的宿主信息。`ctx` 只给需要人机确认或会话状态的护栏透传。 */
export type GuardEnv = {
  cwd: string;
  hasUI: boolean;
  env: Record<string, string | undefined>;
  ctx: ExtensionContext;
};

export type GuardVerdict =
  | { action: "pass" }
  | { action: "block"; kind: GuardKind; rule: string; reason: string };

export type GuardStage = {
  /** 稳定标识，进 reason 与日志；同一个 id 只生效一次。 */
  id: string;
  kind: GuardKind;
  evaluate: (
    call: GuardCall,
    env: GuardEnv,
  ) => GuardVerdict | Promise<GuardVerdict>;
};

export type GuardBlock = {
  rule: string;
  reason: string;
};

export type GuardAggregate =
  | { action: "pass" }
  | { action: "block"; kind: GuardKind; blocks: GuardBlock[] };

export const PASS: GuardVerdict = { action: "pass" };

export const deny = (rule: string, reason: string): GuardVerdict => ({
  action: "block",
  kind: "deny",
  rule,
  reason,
});

export const ask = (rule: string, reason: string): GuardVerdict => ({
  action: "block",
  kind: "ask",
  rule,
  reason,
});

/**
 * bash 命令是不可信输入：超过这个长度就不再做模式匹配，直接按 deny 处理
 * （ADR-0001 D5）。上限取 1 MiB，够放下最大的 heredoc 脚本。
 */
export const MAX_GUARD_TEXT_LENGTH = 1024 * 1024;

export const oversizedVerdict = (call: GuardCall): GuardVerdict =>
  call.text.length > MAX_GUARD_TEXT_LENGTH
    ? deny(
        "input-too-large",
        `拦住原因：这次 ${call.toolName} 调用的主参数有 ${call.text.length} 字符，` +
          `超过护栏扫描上限 ${MAX_GUARD_TEXT_LENGTH}，无法判定是否安全。` +
          "替代写法：拆成多条调用，或把脚本写成文件后执行。",
      )
    : PASS;

const isBlock = (
  verdict: GuardVerdict,
): verdict is Extract<GuardVerdict, { action: "block" }> =>
  verdict.action === "block";

/**
 * 阶段顺序的唯一来源，key 是 **stage id**。没列进来的阶段排在后面、按 id 排。
 * 执行顺序与 reason 的段落顺序都由它决定，与扩展加载顺序无关（ADR-0001 D1）。
 */
export const GUARD_STAGE_RANK: Record<string, number> = {
  "plan-mode": 10,
  "bash-block-guard": 20,
  "safe-delete": 30,
};

const rankOfStage = (stage: GuardStage): number =>
  GUARD_STAGE_RANK[stage.id] ?? 100;

const byStageRank = (left: GuardStage, right: GuardStage): number => {
  const delta = rankOfStage(left) - rankOfStage(right);
  return delta !== 0 ? delta : left.id.localeCompare(right.id);
};

/**
 * 聚合一次调用里所有护栏的判决：deny 恒胜 ask；同一规则只报一次；段落保持
 * 传入顺序 —— 调用方按 GUARD_STAGE_RANK 排过阶段，所以段落顺序同样是确定的。
 */
export function aggregateVerdicts(
  verdicts: readonly GuardVerdict[],
): GuardAggregate {
  const blocks = verdicts.filter(isBlock);
  if (blocks.length === 0) {
    return { action: "pass" };
  }

  const denies = blocks.filter((block) => block.kind === "deny");
  const kind: GuardKind = denies.length > 0 ? "deny" : "ask";
  const picked = denies.length > 0 ? denies : blocks.slice(0, 1);

  const seen = new Set<string>();
  const merged: GuardBlock[] = [];
  for (const block of picked) {
    if (seen.has(block.rule)) continue;
    seen.add(block.rule);
    merged.push({ rule: block.rule, reason: block.reason });
  }
  return { action: "block", kind, blocks: merged };
}

/**
 * 人读的拦下原因；多个护栏命中时每段之间空一行。
 * 放行返回 undefined，不返回空串 —— 空串是一个合法的 reason，会掩盖判断错误。
 */
export function formatBlockReason(
  toolName: string,
  aggregate: GuardAggregate,
): string | undefined {
  if (aggregate.action === "pass") {
    return undefined;
  }
  const rules = aggregate.blocks.map((block) => block.rule).join(", ");
  const body = aggregate.blocks.map((block) => block.reason).join("\n\n");
  return `拦下 ${toolName}（${aggregate.kind}: ${rules}）\n${body}`;
}

/** pi 的 tool_call 返回值；放行时返回 undefined。 */
export const toToolCallResult = (
  toolName: string,
  aggregate: GuardAggregate,
): { block: true; reason: string } | undefined => {
  const reason = formatBlockReason(toolName, aggregate);
  return reason === undefined ? undefined : { block: true, reason };
};

/** 从工具名与参数里取这次调用；只有 bash 的 command 参与长度上限。 */
export const readGuardCall = (toolName: string, input: unknown): GuardCall => {
  const command =
    toolName === "bash" &&
    typeof input === "object" &&
    input !== null &&
    typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
  return { toolName, input, text: command };
};

const REGISTRY_KEY = Symbol.for("pi-kit.guard-pipeline");

type GuardRegistry = {
  stages: GuardStage[];
  /** 已经装过处理器的 pi 实例。真机上一个进程只有一个，测试里每个 harness 一个。 */
  installed: WeakSet<object>;
};

const getRegistry = (): GuardRegistry => {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[REGISTRY_KEY];
  if (existing && typeof existing === "object" && "stages" in existing) {
    return existing as GuardRegistry;
  }
  const next: GuardRegistry = { stages: [], installed: new WeakSet() };
  holder[REGISTRY_KEY] = next;
  return next;
};

/**
 * 注册一个护栏。同一个 id 重复注册**覆盖**旧阶段：扩展 reload 之后必须用新的
 * 闭包（新 controller、新 pi），否则护栏会一直按上一次加载的状态判定。
 */
export function registerGuard(stage: GuardStage): void {
  const registry = getRegistry();
  const index = registry.stages.findIndex(
    (existing) => existing.id === stage.id,
  );
  if (index === -1) {
    registry.stages.push(stage);
    return;
  }
  registry.stages[index] = stage;
}

export const registeredGuards = (): readonly GuardStage[] =>
  getRegistry().stages;

/** 只给测试用：清空阶段与安装标记。 */
export function resetGuardPipeline(): void {
  const registry = getRegistry();
  registry.stages = [];
  registry.installed = new WeakSet();
}

const runStage = async (
  stage: GuardStage,
  call: GuardCall,
  env: GuardEnv,
): Promise<GuardVerdict> => {
  try {
    return await stage.evaluate(call, env);
  } catch (error) {
    // 护栏自己出错时 fail-closed：说不出"安全"就不放行。
    const message = error instanceof Error ? error.message : String(error);
    return deny(
      `stage-error:${stage.id}`,
      `拦住原因：护栏 ${stage.id} 判定时出错（${message}），按失败即拦处理。`,
    );
  }
};

/**
 * 跑完一次调用的全部阶段。deny 先跑完，再跑 ask：这样人机确认不会挡住
 * 确定的拒绝，也不会在明确该拒的时候还去打扰用户。
 */
export async function evaluateGuards(
  call: GuardCall,
  env: GuardEnv,
): Promise<GuardAggregate> {
  const oversized = oversizedVerdict(call);
  if (oversized.action === "block") {
    return aggregateVerdicts([oversized]);
  }

  const stages = [...getRegistry().stages].sort(byStageRank);
  const denyVerdicts: GuardVerdict[] = [];
  for (const stage of stages) {
    if (stage.kind !== "deny") continue;
    denyVerdicts.push(await runStage(stage, call, env));
  }
  const denied = aggregateVerdicts(denyVerdicts);
  if (denied.action === "block") {
    return denied;
  }

  for (const stage of stages) {
    if (stage.kind !== "ask") continue;
    const verdict = await runStage(stage, call, env);
    const blocked = aggregateVerdicts([verdict]);
    if (blocked.action === "block") {
      return blocked;
    }
  }
  return { action: "pass" };
}

/**
 * 安装唯一的 tool_call 处理器。多个扩展各自调用它也只装一次，所以护栏是否
 * 生效不再取决于扩展加载顺序。
 */
export function installGuardPipeline(pi: ExtensionAPI): void {
  const registry = getRegistry();
  if (registry.installed.has(pi)) {
    return;
  }
  registry.installed.add(pi);

  pi.on("tool_call", async (event, ctx) => {
    const call = readGuardCall(event.toolName, event.input);
    const aggregate = await evaluateGuards(call, {
      cwd: typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(),
      hasUI: Boolean(ctx?.hasUI),
      env: process.env,
      ctx: ctx as GuardEnv["ctx"],
    });
    return toToolCallResult(event.toolName, aggregate);
  });
}
