export function getLocalProjectBoardRuntimeMode(): {
  actionsEnabled: false;
  terminalUnavailableMessage: string;
} {
  return {
    actionsEnabled: false,
    terminalUnavailableMessage:
      "Terminal runtime is unavailable for local project boards in this flow.",
  };
}
