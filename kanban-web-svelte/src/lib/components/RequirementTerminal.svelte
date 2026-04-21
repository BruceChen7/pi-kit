<script lang="ts">
import { onDestroy } from "svelte";

import { KanbanRuntimeApi } from "../api";
import { createWTermSurface } from "../terminal/wterm-surface";
import type { RequirementDetail } from "../types";

export let detail: RequirementDetail | null;

const api = new KanbanRuntimeApi();
const terminalSurface = createWTermSurface();

let currentKey = "";
let stream: EventSource | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let loading = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let error: string | null = null;
let connection: "idle" | "connecting" | "connected" | "exited" | "error" =
  "idle";
let requestVersion = 0;
let terminalWritable = false;

$: nextKey = detail
  ? `${detail.requirement.id}:${detail.activeSession?.id ?? "none"}:${detail.terminal.status}`
  : "";
$: if (nextKey !== currentKey) {
  currentKey = nextKey;
  void reconnect();
}

$: terminalSurface.setInputHandler(
  terminalWritable
    ? (input) => {
        void sendRawInput(input);
      }
    : null,
);

function disconnect(): void {
  stream?.close();
  stream = null;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte use: directive references this function.
function mountTerminal(node: HTMLDivElement): { destroy: () => void } {
  void terminalSurface.mount(node).catch((mountError) => {
    error =
      mountError instanceof Error ? mountError.message : String(mountError);
    connection = "error";
  });

  return {
    destroy() {
      terminalSurface.destroy();
    },
  };
}

async function reconnect(): Promise<void> {
  disconnect();
  const version = ++requestVersion;
  error = null;
  connection = deriveConnection(detail);
  loading = detail?.terminal.status === "live";
  terminalWritable =
    detail?.terminal.status === "live"
      ? false
      : (detail?.terminal.writable ?? false);

  try {
    await terminalSurface.reset();
  } catch (resetError) {
    if (version !== requestVersion) {
      return;
    }
    error =
      resetError instanceof Error ? resetError.message : String(resetError);
    connection = "error";
    loading = false;
    return;
  }

  if (!detail || detail.terminal.status !== "live") {
    loading = false;
    return;
  }

  const nextStream = api.createTerminalEventSource(detail.terminal.streamUrl);
  nextStream.addEventListener("ready", () => {
    connection = "connected";
    loading = false;
    terminalWritable = true;
    terminalSurface.focus();
  });
  nextStream.addEventListener("chunk", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        chunk?: string;
      };
      terminalSurface.write(payload.chunk ?? "");
    } catch (streamError) {
      error =
        streamError instanceof Error
          ? streamError.message
          : String(streamError);
      connection = "error";
    }
  });
  nextStream.addEventListener("exit", (event) => {
    connection = "exited";
    terminalWritable = false;
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        summary?: string;
      };
      if (payload.summary) {
        terminalSurface.write(`\r\n[exit] ${payload.summary}\r\n`);
      }
    } catch {
      // ignore malformed exit payloads
    }
  });
  nextStream.addEventListener("error", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        error?: string;
      };
      error = payload.error ?? "Terminal stream unavailable";
    } catch {
      error = "Terminal stream unavailable";
    }
    connection = "error";
    loading = false;
    terminalWritable = false;
  });
  nextStream.onerror = () => {
    if (connection === "connecting") {
      error = "Terminal stream unavailable";
      connection = "error";
      loading = false;
      terminalWritable = false;
    }
  };

  stream = nextStream;
}

function deriveConnection(
  detailValue: RequirementDetail | null,
): "idle" | "connecting" | "connected" | "exited" | "error" {
  if (!detailValue) {
    return "idle";
  }
  if (detailValue.terminal.status === "live") {
    return "connecting";
  }
  if (detailValue.terminal.status === "exited") {
    return "exited";
  }
  if (detailValue.terminal.status === "error") {
    return "error";
  }
  return "idle";
}

async function sendRawInput(input: string): Promise<void> {
  if (!terminalWritable || !detail?.terminal.writable) {
    return;
  }

  try {
    await api.sendRequirementTerminalInput(detail.requirement.id, input);
  } catch (submitError) {
    error =
      submitError instanceof Error ? submitError.message : String(submitError);
  }
}

onDestroy(() => {
  disconnect();
  terminalSurface.destroy();
});
</script>

<section class="terminal-panel">
  <div class="terminal-panel__header">
    <div>
      <p class="label">Session output</p>
      <h3>Interactive terminal</h3>
    </div>
    <span class="status-chip">{connection}</span>
  </div>

  <div class="terminal-panel__surface wterm-host" use:mountTerminal></div>

  {#if loading}
    <p class="subtle">Connecting terminal…</p>
  {:else if !detail}
    <p class="subtle">Select a requirement to open the workbench.</p>
  {:else if detail.terminal.status === "idle"}
    <p class="subtle">Start a session to open a real shell in this project.</p>
  {:else if detail.terminal.status === "exited"}
    <p class="subtle">Shell exited. Restart session to open a new shell.</p>
  {:else if detail.terminal.status === "error"}
    <p class="subtle">Terminal unavailable. Restart session to recover.</p>
  {/if}

  {#if detail?.terminal.summary}
    <p class="subtle">{detail.terminal.summary}</p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>
