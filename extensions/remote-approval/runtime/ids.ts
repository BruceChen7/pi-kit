import path from "node:path";

const randomId = (): string =>
  `session-${Math.random().toString(36).slice(2, 8)}`;

export const deriveSessionIdentity = (input: {
  cwd: string;
  sessionFile?: string;
  sessionName?: string;
}): {
  sessionId: string;
  sessionLabel: string;
} => {
  const repoName = path.basename(input.cwd);
  const sessionId = input.sessionFile
    ? path.basename(input.sessionFile, path.extname(input.sessionFile))
    : randomId();
  const sessionLabel = `${repoName} · ${input.sessionName?.trim() || (input.sessionFile ? sessionId : "ephemeral")}`;

  return {
    sessionId,
    sessionLabel,
  };
};
