import type { CardRuntimeDetail } from "../types";

export function canSendTerminalLineInput(input: {
  cardId: string | null;
  runtimeDetail: CardRuntimeDetail | null;
  unavailableMessage: string | null;
  terminalInput: string;
  submittingInput: boolean;
}): boolean {
  return Boolean(
    input.cardId &&
      input.runtimeDetail?.session &&
      !input.unavailableMessage &&
      !input.submittingInput &&
      input.terminalInput.trim().length > 0,
  );
}

export async function submitTerminalLineInput(input: {
  cardId: string | null;
  runtimeDetail: CardRuntimeDetail | null;
  unavailableMessage: string | null;
  terminalInput: string;
  submittingInput: boolean;
  sendTerminalInput: (cardId: string, input: string) => Promise<unknown>;
}): Promise<{
  accepted: boolean;
  nextValue: string;
  error: string | null;
}> {
  const nextValue = input.terminalInput;
  const cardId = input.cardId;
  if (
    !cardId ||
    !canSendTerminalLineInput({
      cardId,
      runtimeDetail: input.runtimeDetail,
      unavailableMessage: input.unavailableMessage,
      terminalInput: input.terminalInput,
      submittingInput: input.submittingInput,
    })
  ) {
    return {
      accepted: false,
      nextValue,
      error: null,
    };
  }

  const trimmedInput = input.terminalInput.trim();
  try {
    await input.sendTerminalInput(cardId, trimmedInput);
    return {
      accepted: true,
      nextValue: "",
      error: null,
    };
  } catch (error) {
    return {
      accepted: false,
      nextValue,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
