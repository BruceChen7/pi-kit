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
let connection: "idle" | "connecting" | "connected" | "done" | "error" = "idle";
let inputValue = "";
let inputSubmitting = false;
let requestVersion = 0;

$: nextKey = detail?.requirement.id ?? "";
$: if (nextKey !== currentKey) {
  currentKey = nextKey;
  void reconnect();
}

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
  inputValue = "";
  inputSubmitting = false;
  connection = detail?.runtime.terminalAvailable ? "connecting" : "idle";
  loading = true;

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

  if (!detail?.runtime.terminalAvailable) {
    loading = false;
    return;
  }

  const nextStream = api.createTerminalEventSource(detail.runtime.streamUrl);
  nextStream.addEventListener("ready", () => {
    connection = "connected";
  });
  nextStream.addEventListener("status", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        summary?: string;
      };
      if (payload.summary) {
        terminalSurface.write(`[status] ${payload.summary}\r\n`);
      }
    } catch {
      // ignore malformed status payloads in prototype mode
    }
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
  nextStream.addEventListener("done", (event) => {
    connection = "done";
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        summary?: string;
      };
      if (payload.summary) {
        terminalSurface.write(`\r\n[done] ${payload.summary}\r\n`);
      }
    } catch {
      // ignore malformed done payloads in prototype mode
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
  });
  nextStream.onerror = () => {
    if (connection === "connecting") {
      error = "Terminal stream unavailable";
      connection = "error";
    }
  };

  stream = nextStream;
  loading = false;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template submit handler references this function.
async function submitInput(): Promise<void> {
  if (!detail || detail.requirement.runStage !== "running") {
    return;
  }

  const trimmed = inputValue.trim();
  if (!trimmed || inputSubmitting) {
    return;
  }

  inputSubmitting = true;
  error = null;
  try {
    await api.sendRequirementTerminalInput(detail.requirement.id, trimmed);
    inputValue = "";
  } catch (submitError) {
    error =
      submitError instanceof Error ? submitError.message : String(submitError);
  } finally {
    inputSubmitting = false;
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
      <h3>Prototype terminal</h3>
    </div>
    <span class="status-chip">{connection}</span>
  </div>

  <div class="terminal-panel__surface wterm-host" use:mountTerminal></div>

  {#if loading}
    <p class="subtle">Connecting terminal…</p>
  {:else if !detail}
    <p class="subtle">Select a requirement to open the workbench.</p>
  {:else if !detail.runtime.terminalAvailable}
    <p class="subtle">Start the prototype session to stream output into wterm.</p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if detail?.requirement.runStage === "running"}
    <form class="terminal-input-row" on:submit|preventDefault={submitInput}>
      <input
        bind:value={inputValue}
        class="terminal-input"
        placeholder="Send another line to the prototype session"
      />
      <button class="primary-button" disabled={inputSubmitting || !inputValue.trim()}>
        {inputSubmitting ? "Sending…" : "Send"}
      </button>
    </form>
  {/if}
</section>
