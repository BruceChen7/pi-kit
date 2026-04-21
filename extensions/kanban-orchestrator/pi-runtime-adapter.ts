import type { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
import type { PiRuntimeEventBridge } from "./pi-runtime-event-bridge.js";

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createPiRuntimeAdapterWithDeps(input: {
  runFeatureSwitch: (branch: string) => Promise<void>;
  sendUserMessage: (
    text: string,
    options: {
      deliverAs: "followUp";
    },
  ) => void;
  eventBridge: PiRuntimeEventBridge;
}): AgentRuntimeAdapter {
  return {
    kind: "pi",
    async openSession({ repoPath, worktreePath, taskId, metadata }) {
      const branch = trimToNull(metadata?.branch) ?? trimToNull(worktreePath);
      if (!branch) {
        throw new Error(
          `pi adapter requires branch metadata to open session for task '${taskId}' in '${repoPath}'`,
        );
      }

      await input.runFeatureSwitch(branch);
      const sessionRef = trimToNull(metadata?.sessionRef) ?? branch;
      if (worktreePath) {
        input.eventBridge.attachSession(sessionRef, worktreePath);
      }
      return {
        sessionRef,
        resumable: false,
      };
    },
    async resumeSession(sessionRef: string) {
      return {
        sessionRef,
        attached: false,
        resumable: false,
      };
    },
    async sendPrompt({ prompt }) {
      input.sendUserMessage(prompt, {
        deliverAs: "followUp",
      });
    },
    async interrupt() {
      // no-op until pi exposes targeted session interrupts through the adapter
    },
    async closeSession() {
      // no-op until pi exposes targeted session close semantics through the adapter
    },
    async getSessionStatus() {
      return {
        status: "unknown",
        resumable: false,
      };
    },
    streamEvents(sessionRef: string) {
      return input.eventBridge.streamEvents(sessionRef);
    },
  };
}
