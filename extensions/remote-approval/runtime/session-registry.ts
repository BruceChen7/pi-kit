import { collectStoredAllowRules } from "./persistence.ts";
import { createSessionState } from "./session-state.ts";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

type SessionStateRecord = ReturnType<typeof createSessionState>;

export const createSessionRegistry = () => {
  const sessions = new Map<string, SessionStateRecord>();

  return {
    ensureSession(sessionId: string, sessionLabel: string): SessionStateRecord {
      const existing = sessions.get(sessionId);
      if (existing) {
        return existing;
      }

      const created = createSessionState({ sessionId, sessionLabel });
      sessions.set(sessionId, created);
      return created;
    },

    getSession(sessionId: string): SessionStateRecord | null {
      return sessions.get(sessionId) ?? null;
    },

    restoreSession(
      sessionId: string,
      sessionLabel: string,
      entries: SessionEntry[],
    ): SessionStateRecord {
      const state = createSessionState({ sessionId, sessionLabel });
      for (const rule of collectStoredAllowRules(entries)) {
        state.addAllowRule(rule);
      }
      sessions.set(sessionId, state);
      return state;
    },

    removeSession(sessionId: string): void {
      sessions.delete(sessionId);
    },
  };
};
