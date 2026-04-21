<script lang="ts">
import { onDestroy } from "svelte";

import { KanbanRuntimeApi } from "../api";
import type { CardRuntimeDetail } from "../types";

export let cardId: string | null;
export let activeExecutionCardId: string | null;

const api = new KanbanRuntimeApi();

let runtimeDetail: CardRuntimeDetail | null = null;
let terminalOutput = "";
let loadingRuntime = false;
let terminalError: string | null = null;
let connectionStatus: "idle" | "connecting" | "connected" | "done" | "error" =
  "idle";
let currentKey = "";
let currentRequestId = 0;
let stream: EventSource | null = null;

$: nextKey = cardId ?? "";
$: if (nextKey !== currentKey) {
  currentKey = nextKey;
  void refreshTerminal();
}

function disconnectStream(): void {
  if (!stream) {
    return;
  }

  stream.close();
  stream = null;
}

async function refreshTerminal(): Promise<void> {
  disconnectStream();
  runtimeDetail = null;
  terminalOutput = "";
  terminalError = null;
  connectionStatus = cardId ? "connecting" : "idle";

  if (!cardId) {
    return;
  }

  const requestId = ++currentRequestId;
  loadingRuntime = true;

  try {
    const detail = await api.getCardRuntime(cardId);
    if (requestId !== currentRequestId) {
      return;
    }

    runtimeDetail = detail;
    if (!detail.terminal.available) {
      connectionStatus = "idle";
      return;
    }

    const nextStream = api.createTerminalEventSource(detail.terminal.streamUrl);
    nextStream.addEventListener("ready", () => {
      connectionStatus = "connected";
    });
    nextStream.addEventListener("chunk", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          chunk?: string;
        };
        terminalOutput += payload.chunk ?? "";
      } catch (error) {
        terminalError = error instanceof Error ? error.message : String(error);
        connectionStatus = "error";
      }
    });
    nextStream.addEventListener("done", () => {
      connectionStatus = "done";
    });
    nextStream.addEventListener("error", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          error?: string;
        };
        terminalError = payload.error ?? "Terminal stream unavailable";
      } catch {
        terminalError = "Terminal stream unavailable";
      }
      connectionStatus = "error";
    });
    nextStream.onerror = () => {
      if (connectionStatus === "connecting") {
        terminalError = "Terminal stream unavailable";
        connectionStatus = "error";
      }
    };

    stream = nextStream;
  } catch (error) {
    if (requestId !== currentRequestId) {
      return;
    }

    terminalError = error instanceof Error ? error.message : String(error);
    connectionStatus = "error";
  } finally {
    if (requestId === currentRequestId) {
      loadingRuntime = false;
    }
  }
}

onDestroy(() => {
  disconnectStream();
});
</script>

<section class="terminal-host">
  <div class="terminal-status-row">
    <div class="summary-pill">
      <span class="pill-label">Connection</span>
      <strong>{connectionStatus}</strong>
    </div>
    <div class="summary-pill wide">
      <span class="pill-label">Runtime summary</span>
      <strong>{runtimeDetail?.execution.summary ?? "Waiting for runtime detail"}</strong>
    </div>
  </div>

  {#if loadingRuntime}
    <p class="subtle">Connecting to child runtime…</p>
  {:else if terminalError}
    <p class="error">{terminalError}</p>
  {:else if !cardId}
    <p class="empty-state">Select a child card to attach the terminal surface.</p>
  {:else if !runtimeDetail?.terminal.available}
    <p class="empty-state">No live terminal available for this child yet.</p>
  {:else}
    <div class="terminal-meta-grid">
      <div>
        <dt>Card</dt>
        <dd>{cardId}</dd>
      </div>
      <div>
        <dt>Execution focus</dt>
        <dd>{activeExecutionCardId === cardId ? "active" : "standby"}</dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>{runtimeDetail?.session?.chatJid ?? "<none>"}</dd>
      </div>
      <div>
        <dt>Worktree</dt>
        <dd>{runtimeDetail?.session?.worktreePath ?? "<none>"}</dd>
      </div>
    </div>

    <pre class="terminal-surface">{terminalOutput || runtimeDetail?.execution.summary || "Waiting for terminal output…"}</pre>
  {/if}
</section>
