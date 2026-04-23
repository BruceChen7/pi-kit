import type { RemoteApprovalConfig } from "../config.ts";
import { deriveSessionIdentity } from "./ids.ts";
import { createRequestStore } from "./request-store.ts";
import { createSessionRegistry } from "./session-registry.ts";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

type ActiveSession = {
  identity: ReturnType<typeof deriveSessionIdentity>;
  config: RemoteApprovalConfig;
  requestStore: ReturnType<typeof createRequestStore>;
  sessionState: ReturnType<
    ReturnType<typeof createSessionRegistry>["ensureSession"]
  >;
};

export const createAppRuntime = () => {
  const sessionRegistry = createSessionRegistry();
  const activeSessions = new Map<string, ActiveSession>();

  return {
    startSession(input: {
      cwd: string;
      sessionFile?: string;
      sessionName?: string;
      config: RemoteApprovalConfig;
      entries: SessionEntry[];
    }): ActiveSession {
      const identity = deriveSessionIdentity({
        cwd: input.cwd,
        sessionFile: input.sessionFile,
        sessionName: input.sessionName,
      });
      const sessionState = sessionRegistry.restoreSession(
        identity.sessionId,
        identity.sessionLabel,
        input.entries,
      );

      const activeSession: ActiveSession = {
        identity,
        config: input.config,
        requestStore: createRequestStore(),
        sessionState,
      };
      activeSessions.set(identity.sessionId, activeSession);
      return activeSession;
    },

    getSession(sessionId: string): ActiveSession | null {
      return activeSessions.get(sessionId) ?? null;
    },

    shutdownSession(sessionId: string): void {
      activeSessions.delete(sessionId);
      sessionRegistry.removeSession(sessionId);
    },
  };
};
