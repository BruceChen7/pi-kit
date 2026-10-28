/**
 * agent profile 发现与合并（Functional Core）。
 *
 * 输入是 `{name, content, source}` 这样一份纯数据，读盘留在 Shell（index.ts）。
 * 这样合并规则可以用表驱动测试覆盖，不需要造临时目录。
 */

import { parseFrontmatter } from "../shared/frontmatter.ts";

export type AgentThinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type AgentSourceKind = "builtin" | "user" | "project";

export type AgentSource = {
  name: string;
  content: string;
  source: AgentSourceKind;
};

/**
 * 子会话的额外能力。**默认不连 MCP**，profile 写 `mcp: inherit` 才跟随父会话。
 *
 * 默认关是因为每个 child 都新建一份 MCP 客户端，而 `session.dispose()` 不关它的
 * transport socket：N 个 child 漏 2N 条空闲 TLS 连接，`pi --print` 下进程永不退出。
 *
 * 之所以不做 server 子集：`loadMcpConfig` 没有从包根导出，自己读 mcp.json
 * 会变成第二份配置解析。先做全有/全无，需要子集时再单独加。
 */
export type McpMode = "inherit" | "none";

export type AgentProfile = {
  name: string;
  description: string;
  /** 硬白名单。空数组按只读默认处理。 */
  tools: string[];
  model?: string;
  thinking?: AgentThinking;
  promptMode: "append" | "replace";
  prompt: string;
  source: AgentSourceKind;
  /** undefined = 跟随父会话是否激活了 codemode。 */
  codemode?: boolean;
  mcp: McpMode;
};

/** 只读默认：没写 tools 的 agent 拿这四个。 */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** `general` 的默认工具集。 */
export const FULL_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
] as const;

const THINKING_LEVELS: readonly AgentThinking[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const SOURCE_RANK: Record<AgentSourceKind, number> = {
  builtin: 0,
  user: 1,
  project: 2,
};

/**
 * 内置 profile 也走同一条 frontmatter 解析路径。
 * 不在这里直接构造对象，否则就成了第二份定义。
 */
export const BUILTIN_AGENTS: readonly AgentSource[] = [
  {
    name: "general",
    source: "builtin",
    content: [
      "---",
      "name: general",
      "description: 通用实现者，继承父会话的模型与思考等级。",
      `tools: ${FULL_TOOLS.join(", ")}`,
      "promptMode: append",
      "---",
      "You are a focused subagent working on one task handed to you by the parent session.",
      "Do the work end to end, then report the outcome. Do not ask the parent for permission it already gave you.",
      "Keep the final message short: what you did, what you verified, what remains.",
    ].join("\n"),
  },
  {
    name: "explore",
    source: "builtin",
    content: [
      "---",
      "name: explore",
      "description: 只读代码侦察，返回文件、符号与数据流。",
      `tools: ${READONLY_TOOLS.join(", ")}`,
      "promptMode: replace",
      "---",
      "You are a read-only code scout.",
      "Locate the relevant files, entry points, and data flow for the given question.",
      "Report concrete file paths and symbols. Never claim to have changed anything.",
    ].join("\n"),
  },
  {
    name: "reviewer",
    source: "builtin",
    content: [
      "---",
      "name: reviewer",
      "description: 只读评审，挑正确性、测试与复杂度问题。",
      `tools: ${READONLY_TOOLS.join(", ")}`,
      "promptMode: replace",
      "---",
      "You are an independent code reviewer with fresh context.",
      "Lead with concrete defects: correctness, missing tests, unnecessary complexity.",
      "Cite file and line. If you find nothing material, say so plainly instead of padding.",
    ].join("\n"),
  },
];

export function parseToolList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "on")
    return true;
  if (normalized === "false" || normalized === "no" || normalized === "off")
    return false;
  return undefined;
}

/** 只有显式要才继承；缺省与认不出来的值都落到 `none`。 */
function parseMcpMode(raw: string | undefined): McpMode {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === "inherit" ||
    normalized === "on" ||
    normalized === "true"
  ) {
    return "inherit";
  }
  return "none";
}

function parseThinking(raw: string | undefined): AgentThinking | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return THINKING_LEVELS.find((level) => level === normalized);
}

export function toProfile(source: AgentSource): AgentProfile {
  const parsed = parseFrontmatter(source.content, source.name);
  const declaredTools = parseToolList(parsed.fields.tools);
  const promptMode =
    parsed.fields.promptMode === "replace" ? "replace" : "append";
  const body = parsed.body.trim();

  return {
    name: parsed.name,
    description: parsed.description,
    tools: declaredTools.length > 0 ? declaredTools : [...READONLY_TOOLS],
    model: parsed.fields.model || undefined,
    thinking: parseThinking(parsed.fields.thinking),
    promptMode,
    prompt: body || parsed.description,
    source: source.source,
    codemode: parseBoolean(parsed.fields.codemode),
    mcp: parseMcpMode(parsed.fields.mcp),
  };
}

/**
 * 按 `project > user > builtin` 合并同名 profile。
 * 同层级重复出现时，先到者胜（读盘顺序即优先级，由 Shell 保证）。
 */
export function discoverProfiles(
  sources: readonly AgentSource[],
): AgentProfile[] {
  const byName = new Map<string, AgentProfile>();

  for (const source of sources) {
    const profile = toProfile(source);
    const existing = byName.get(profile.name);
    if (
      existing &&
      SOURCE_RANK[profile.source] <= SOURCE_RANK[existing.source]
    ) {
      continue;
    }
    byName.set(profile.name, profile);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findProfile(
  profiles: readonly AgentProfile[],
  name: string,
): AgentProfile | undefined {
  const normalized = name.trim().toLowerCase();
  return profiles.find((profile) => profile.name.toLowerCase() === normalized);
}
