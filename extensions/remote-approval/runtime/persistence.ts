import type { SessionAllowRule } from "./session-state.ts";

export const REMOTE_APPROVAL_ALLOW_RULE_TYPE = "remote-approval-allow-rule";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isValidScope = (value: unknown): value is SessionAllowRule["scope"] =>
  value === "exact-command" || value === "path-prefix" || value === "tool-wide";

const normalizeAllowRule = (value: unknown): SessionAllowRule | null => {
  if (!isRecord(value)) {
    return null;
  }

  const toolName = value.toolName;
  const scope = value.scope;
  const ruleValue = value.value;
  const createdAt = value.createdAt;

  if (
    typeof toolName !== "string" ||
    !isValidScope(scope) ||
    typeof ruleValue !== "string" ||
    typeof createdAt !== "number"
  ) {
    return null;
  }

  return {
    toolName,
    scope,
    value: ruleValue,
    createdAt,
  };
};

export const collectStoredAllowRules = (
  entries: SessionEntry[],
): SessionAllowRule[] => {
  const rules: SessionAllowRule[] = [];

  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== REMOTE_APPROVAL_ALLOW_RULE_TYPE
    ) {
      continue;
    }
    const rule = normalizeAllowRule(entry.data);
    if (rule) {
      rules.push(rule);
    }
  }

  return rules;
};

export const persistAllowRule = (
  pi: { appendEntry: (customType: string, data?: unknown) => void },
  rule: SessionAllowRule,
): void => {
  pi.appendEntry(REMOTE_APPROVAL_ALLOW_RULE_TYPE, rule);
};
