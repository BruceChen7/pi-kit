import type { createRequestStore } from "../runtime/request-store.ts";
import { queueRemoteInstruction } from "./continue.ts";

type RequestStore = ReturnType<typeof createRequestStore>;

type IdleChannel = {
  sendMessage: (input: {
    text: string;
    buttons?: Array<Array<{ text: string; callback_data: string }>>;
    parseMode?: string;
  }) => Promise<number>;
  editMessage: (
    messageId: number,
    input: {
      text: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
      parseMode?: string;
    },
  ) => Promise<void>;
  sendReplyPrompt: (messageId: number, text: string) => Promise<number>;
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

type PiLike = {
  sendUserMessage: (
    content: string,
    options?: { deliverAs?: "followUp" },
  ) => void;
};

type ExecutionContext = {
  isIdle: () => boolean;
};

type IdleFlowRequest = {
  requestId: string;
  sessionId: string;
  sessionLabel: string;
  assistantSummary: string | null;
  contextPreview: string[];
  continueEnabled: boolean;
  fullContextAvailable: boolean;
  fullContextLines?: string[];
};

type IdleFlowInput = {
  requestStore: RequestStore;
  channel: IdleChannel;
  pi: PiLike;
  executionContext: ExecutionContext;
  request: IdleFlowRequest;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
};

type IdleFlowResult = {
  requestId: string;
  status: "dismissed" | "continued" | "failed";
  resolutionSource: "remote" | "system";
  messageId: number;
  replyPromptMessageId: number | null;
  continueResult: "started" | "queued" | null;
};

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const buildIdleButtons = (
  continueEnabled: boolean,
): Array<Array<{ text: string; callback_data: string }>> => {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (!continueEnabled) {
    rows.push([{ text: "❌ Dismiss", callback_data: "idle:dismiss" }]);
    return rows;
  }

  rows.push([
    { text: "✏️ Continue", callback_data: "idle:continue" },
    { text: "❌ Dismiss", callback_data: "idle:dismiss" },
  ]);
  return rows;
};

const buildIdleMessageText = (request: IdleFlowRequest): string => {
  const lines = [`💤 Agent idle`, ``, request.sessionLabel];

  if (request.assistantSummary) {
    lines.push("", request.assistantSummary);
  }

  if (request.contextPreview.length > 0) {
    lines.push("", ...request.contextPreview);
  }

  return lines.join("\n");
};

const buildResolvedText = (
  request: IdleFlowRequest,
  status: "dismissed" | "continued" | "failed",
  continueResult: "started" | "queued" | null,
): string => {
  if (status === "dismissed") {
    return `💤 Agent idle · ❌ Dismissed\n\n${request.sessionLabel}`;
  }
  if (status === "failed") {
    return `💤 Agent idle · ⚠️ Continue failed\n\n${request.sessionLabel}`;
  }
  if (continueResult === "queued") {
    return `💤 Agent idle · ✅ Queued as follow-up\n\n${request.sessionLabel}`;
  }
  return `💤 Agent idle · ✅ Resumed\n\n${request.sessionLabel}`;
};

export const runIdleContinueFlow = async ({
  requestStore,
  channel,
  pi,
  executionContext,
  request,
  sleep = defaultSleep,
  pollIntervalMs = 1000,
}: IdleFlowInput): Promise<IdleFlowResult> => {
  const stored = requestStore.create({
    requestId: request.requestId,
    kind: "idle_continue",
    sessionId: request.sessionId,
    sessionLabel: request.sessionLabel,
    contextPreview: request.contextPreview,
    fullContextAvailable: request.fullContextAvailable,
  });

  const buttons = buildIdleButtons(request.continueEnabled);
  if ((request.fullContextLines?.length ?? 0) > 0) {
    buttons.push([{ text: "📖 Full context", callback_data: "idle:more" }]);
  }

  const messageId = await channel.sendMessage({
    text: buildIdleMessageText(request),
    buttons,
  });
  stored.telegramMessageId = messageId;

  let replyPromptMessageId: number | null = null;
  let waitingForInstruction = false;

  while (true) {
    const acceptedMessageIds =
      replyPromptMessageId === null
        ? [messageId]
        : [messageId, replyPromptMessageId];
    const update = await channel.poll(acceptedMessageIds);

    if (!update) {
      await sleep(pollIntervalMs);
      continue;
    }

    if (update.type === "callback") {
      if (update.data === "idle:more") {
        for (const line of request.fullContextLines ?? []) {
          await channel.sendReply(messageId, line);
        }
        continue;
      }

      if (update.data === "idle:dismiss") {
        requestStore.resolve(request.requestId, "dismissed", "remote");
        await channel.editMessage(messageId, {
          text: buildResolvedText(request, "dismissed", null),
          buttons: [],
        });
        return {
          requestId: request.requestId,
          status: "dismissed",
          resolutionSource: "remote",
          messageId,
          replyPromptMessageId,
          continueResult: null,
        };
      }

      if (
        update.data === "idle:continue" &&
        request.continueEnabled &&
        !waitingForInstruction
      ) {
        waitingForInstruction = true;
        replyPromptMessageId = await channel.sendReplyPrompt(
          messageId,
          "💬 Reply with your next instruction",
        );
        stored.replyPromptMessageId = replyPromptMessageId;
      }

      continue;
    }

    if (update.type === "text" && waitingForInstruction) {
      const continueResult = queueRemoteInstruction(
        pi,
        executionContext,
        update.text,
      );
      requestStore.resolve(request.requestId, "continued", "remote");
      await channel.editMessage(messageId, {
        text: buildResolvedText(request, "continued", continueResult),
        buttons: [],
      });
      return {
        requestId: request.requestId,
        status: "continued",
        resolutionSource: "remote",
        messageId,
        replyPromptMessageId,
        continueResult,
      };
    }
  }
};
