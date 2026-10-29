/* biome-ignore-all lint/suspicious/noExplicitAny: `Model<any>` 是 pi 自己的签名，这里不重写它的泛型。 */
/**
 * 子会话 boot / dispose / steer（Imperative Shell）。
 *
 * 这里是整个 subagent 扩展唯一的会话副作用出口：磁盘、模型解析、进程内
 * AgentSession 都只在这里发生。判断逻辑在 agents.ts / core.ts，不在这里。
 *
 * 隔离沿用了 extensions/btw/session.ts 已验证过的写法：
 * `noExtensions` + `disabledBuiltinExtensions` + tools 白名单。
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  getAgentDir,
  type ProviderConfig,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  collectProviderRegistrations,
  createProviderForwardingExtension,
  type ProviderRegistration,
} from "../shared/child-session-providers.ts";
import type { AgentProfile, AgentThinking } from "./agents.ts";

export type ModelRegistryLike = {
  find(provider: string, modelId: string): Model<any> | undefined;
};

/**
 * 子会话的额外能力。由 Shell 在看得到父会话的时候算好传进来：
 * codemode 跟父会话的 active tool 走，MCP 跟父会话的 mcp.json 走（除非 profile 关）。
 */
export type ChildCapabilities = {
  codemode: boolean;
  mcp: boolean;
};

export type BootChildInput = {
  profile: AgentProfile;
  cwd: string;
  parentModel: Model<any> | undefined;
  parentThinking: AgentThinking | undefined;
  capabilities: ChildCapabilities;
  modelRegistry?: ModelRegistryLike;
  /**
   * 父会话里由扩展注册的 provider 配置（cc-switch 这类本地网关就在其中）。
   * 子会话不加载扩展，拿不到这些注册，模型认证会以
   * `No API key found for "<provider>"` 失败，所以由 Shell 从父会话的
   * ModelRegistry 取出来传进来。
   */
  resolveProviderConfig?: (provider: string) => ProviderConfig | undefined;
  agentDir?: string;
};

export type BootChildResult = {
  session: AgentSession;
  modelWarning?: string;
};

/** `provider/modelId` 拆成两段。没有斜杠时返回 null（交给调用方回落）。 */
export function splitModelRef(
  ref: string,
): { provider: string; modelId: string } | null {
  const index = ref.indexOf("/");
  if (index <= 0 || index === ref.length - 1) return null;
  return { provider: ref.slice(0, index), modelId: ref.slice(index + 1) };
}

/**
 * profile 指定了 model 就解析；解析不到不报错，回落到父会话模型并返回一条 warning。
 * 静默回落会让"为什么我的 agent 用了贵模型"变成排查难题，所以必须把 warning 传出去。
 */
export function resolveAgentModel(input: {
  ref: string | undefined;
  parentModel: Model<any> | undefined;
  modelRegistry?: ModelRegistryLike;
}): { model: Model<any> | undefined; warning?: string } {
  const { ref, parentModel, modelRegistry } = input;
  if (!ref) return { model: parentModel };

  const parsed = splitModelRef(ref);
  if (!parsed) {
    return {
      model: parentModel,
      warning: `model "${ref}" is not provider/modelId`,
    };
  }

  const found = modelRegistry?.find(parsed.provider, parsed.modelId);
  if (!found) {
    return {
      model: parentModel,
      warning: `model "${ref}" not found in the registry; inheriting the parent model`,
    };
  }

  return { model: found };
}

/**
 * 子会话的 resource loader 选项。纯函数，方便断言隔离边界。
 *
 * `noExtensions: true` 关掉的只是**扩展发现**和内置扩展，工具白名单依然是硬边界：
 * 实测 tools=["read","codemode"] 的子会话里，codemode 脚本调 bash 会直接
 * `REJECTED: tools.bash does not exist`。MCP 不一样 —— 它的默认 exposure 是
 * `codemode`，注册即可调用，不受 tools 白名单约束，所以 MCP 只有开/关两档，
 * 由 profile 的 `mcp:` 决定，缺省跟随父会话。
 *
 * provider 注册是这条隔离的一个例外：子会话要用的模型如果由扩展注册，扩展不加载就
 * 认证不了，所以父会话把该 provider 的注册单独转交进来。
 */
export function childResourceLoaderOptions(input: {
  cwd: string;
  agentDir: string;
  profile: AgentProfile;
  capabilities: ChildCapabilities;
  providerRegistrations: readonly ProviderRegistration[];
}): ConstructorParameters<typeof DefaultResourceLoader>[0] {
  const extensionFactories = [
    ...(input.providerRegistrations.length > 0
      ? [createProviderForwardingExtension(input.providerRegistrations)]
      : []),
    ...(input.capabilities.codemode ? [createCodemodeExtension()] : []),
    ...(input.capabilities.mcp ? [createMcpExtension()] : []),
  ];

  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    disabledBuiltinExtensions: ["mcp", "codemode"],
    extensionFactories,
    systemPrompt:
      input.profile.promptMode === "replace" ? input.profile.prompt : undefined,
    appendSystemPrompt:
      input.profile.promptMode === "append"
        ? [input.profile.prompt]
        : undefined,
  };
}

export async function bootChildSession(
  input: BootChildInput,
): Promise<BootChildResult> {
  const agentDir = input.agentDir ?? getAgentDir();

  const { model, warning } = resolveAgentModel({
    ref: input.profile.model,
    parentModel: input.parentModel,
    modelRegistry: input.modelRegistry,
  });

  // 先定模型再建 loader：要带进子会话的 provider 就是这些模型会用到的 provider。
  const providerRegistrations = collectProviderRegistrations({
    providers: [model?.provider, input.parentModel?.provider],
    getConfig: (provider) => input.resolveProviderConfig?.(provider),
  });

  const loader = new DefaultResourceLoader(
    childResourceLoaderOptions({
      cwd: input.cwd,
      agentDir,
      profile: input.profile,
      capabilities: input.capabilities,
      providerRegistrations,
    }),
  );
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    model,
    thinkingLevel: input.profile.thinking ?? input.parentThinking,
    tools: [...input.profile.tools],
    sessionManager: SessionManager.inMemory(input.cwd),
    resourceLoader: loader,
  });

  // MCP 扩展在 session_start 连服务器，需要先绑定扩展上下文；headless 子会话
  // 没有 UI，绑一个空对象就够（实测可用）。
  if (input.capabilities.codemode || input.capabilities.mcp) {
    await session.bindExtensions({});
  }

  return { session, modelWarning: warning };
}

/** steer：把方向插进正在跑的这一轮。返回是否真的投递进了一个活跃会话。 */
export async function steerChild(
  session: AgentSession,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  await session.steer(trimmed);
  return true;
}

export function disposeChild(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
    // dispose 竞态可忽略：会话已经不可用，再抛错只会盖住真实失败。
  }
}

export type { AgentSession };
