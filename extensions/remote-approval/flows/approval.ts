import type { createRequestStore } from "../runtime/request-store.ts";
import type { SessionAllowRule } from "../runtime/session-state.ts";

export type ApprovalDecision = "allow" | "always" | "deny";

const buildApprovalButtons = (
  includeAlways: boolean,
): Array<Array<{ text: string; callback_data: string }>> => {
  const buttons = [[{ text: "✅ Allow", callback_data: "allow" }]];
  if (includeAlways) {
    buttons[0].push({ text: "✅ Always", callback_data: "always" });
  }
  buttons.push([{ text: "❌ Deny", callback_data: "deny" }]);
  return buttons;
};

type RequestStore = ReturnType<typeof createRequestStore>;

type ApprovalRaceInput = {
  requestId: string;
  requestStore: RequestStore;
  localApproval: Promise<ApprovalDecision>;
  remoteApproval: Promise<ApprovalDecision>;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  now?: () => number;
};

type ApprovalRaceResult = {
  decision: ApprovalDecision;
  resolvedBy: "local" | "remote";
  status: "approved" | "always" | "denied";
  allowRule: SessionAllowRule | null;
};

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const deriveAllowRule = (
  toolName: string,
  toolInput: Record<string, unknown>,
  createdAt: number,
): SessionAllowRule | null => {
  if (toolName === "bash") {
    const command = normalizeText(toolInput.command);
    return command
      ? {
          toolName,
          scope: "exact-command",
          value: command,
          createdAt,
        }
      : null;
  }

  if (toolName === "write" || toolName === "edit") {
    const filePath =
      normalizeText(toolInput.filePath) ?? normalizeText(toolInput.file_path);
    return filePath
      ? {
          toolName,
          scope: "path-prefix",
          value: filePath,
          createdAt,
        }
      : null;
  }

  return {
    toolName,
    scope: "tool-wide",
    value: toolName,
    createdAt,
  };
};

const toResolvedStatus = (
  decision: ApprovalDecision,
): "approved" | "always" | "denied" => {
  switch (decision) {
    case "allow":
      return "approved";
    case "always":
      return "always";
    case "deny":
      return "denied";
  }
};

export const requestRemoteApproval = async (input: {
  channel: {
    sendMessage: (message: {
      text: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
      parseMode?: string;
    }) => Promise<number>;
    sendReply: (
      messageId: number,
      text: string,
      parseMode?: string,
    ) => Promise<number>;
    poll: (
      acceptedMessageIds: Iterable<number>,
    ) => Promise<
      { type: "callback"; data: string } | { type: "text"; text: string } | null
    >;
  };
  text: string;
  includeAlways: boolean;
  fullContextLines?: string[];
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}): Promise<{ decision: ApprovalDecision; messageId: number }> => {
  const sleep =
    input.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  const buttons = buildApprovalButtons(input.includeAlways);
  if ((input.fullContextLines?.length ?? 0) > 0) {
    buttons.push([{ text: "📖 Full context", callback_data: "more" }]);
  }

  const messageId = await input.channel.sendMessage({
    text: input.text,
    buttons,
  });

  while (true) {
    const update = await input.channel.poll([messageId]);
    if (!update) {
      await sleep(input.pollIntervalMs ?? 1000);
      continue;
    }
    if (update.type !== "callback") {
      continue;
    }
    if (update.data === "more") {
      for (const line of input.fullContextLines ?? []) {
        await input.channel.sendReply(messageId, line);
      }
      continue;
    }
    if (
      update.data === "allow" ||
      update.data === "always" ||
      update.data === "deny"
    ) {
      return {
        decision: update.data,
        messageId,
      };
    }
  }
};

export const runApprovalRace = async ({
  requestId,
  requestStore,
  localApproval,
  remoteApproval,
  toolName,
  toolInput,
  now = Date.now,
}: ApprovalRaceInput): Promise<ApprovalRaceResult> => {
  const contenders = [
    localApproval.then((decision) => ({
      decision,
      resolvedBy: "local" as const,
    })),
    remoteApproval.then((decision) => ({
      decision,
      resolvedBy: "remote" as const,
    })),
  ];

  const winner = await Promise.race(contenders);
  const status = toResolvedStatus(winner.decision);
  requestStore.resolve(requestId, status, winner.resolvedBy);

  const allowRule =
    winner.decision === "always" && toolName && toolInput
      ? deriveAllowRule(toolName, toolInput, now())
      : null;

  return {
    decision: winner.decision,
    resolvedBy: winner.resolvedBy,
    status,
    allowRule,
  };
};
