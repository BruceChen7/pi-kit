type PiLike = {
  sendUserMessage: (
    content: string,
    options?: { deliverAs?: "followUp" },
  ) => void;
};

type ContextLike = {
  isIdle: () => boolean;
};

export const queueRemoteInstruction = (
  pi: PiLike,
  ctx: ContextLike,
  instruction: string,
): "started" | "queued" => {
  if (ctx.isIdle()) {
    pi.sendUserMessage(instruction);
    return "started";
  }

  pi.sendUserMessage(instruction, { deliverAs: "followUp" });
  return "queued";
};
