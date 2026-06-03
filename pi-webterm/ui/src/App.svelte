<script lang="ts">
import { onDestroy, onMount } from "svelte";
import {
  createTerminal,
  disposeTerminal,
  focusTerminal,
  writeToTerminal,
} from "./lib/terminal";
import { type ConnectionStatus, WsClient } from "./lib/ws";
import "xterm/css/xterm.css";
import "./app.css";

let terminalContainer: HTMLDivElement | undefined = $state();
let serverUrl = $state(`ws://${window.location.host}`);
let token = $state(localStorage.getItem("pi-webterm-token") || "");
let status: ConnectionStatus = $state("disconnected");
let _errorMsg = $state("");
let _connected = $state(false);
// eslint-disable-next-line svelte/state_referenced_locally
let showSetup = $state(!token);

let wsClient: WsClient | null = null;

const _statusText = $derived(
  status === "connected"
    ? "已连接"
    : status === "connecting"
      ? "连接中..."
      : status === "error"
        ? "连接失败"
        : "未连接",
);

function onConnect() {
  if (!token) return;
  localStorage.setItem("pi-webterm-token", token);

  wsClient?.disconnect();

  wsClient = new WsClient({
    url: `${serverUrl}/ws`,
    token,
    onOpen: () => {
      status = "connected";
      _connected = true;
      showSetup = false;
      _errorMsg = "";
      focusTerminal();
    },
    onClose: () => {
      status = "disconnected";
      _connected = false;
    },
    onError: () => {
      status = "error";
      _errorMsg = "连接失败";
    },
    onFatalError: (code: number, reason: string) => {
      status = "error";
      const msg =
        code === 4001
          ? "认证失败，Token 不匹配"
          : code === 4002
            ? "会话连接失败"
            : reason;
      _errorMsg = msg;
    },
    onOutput: (data: string) => {
      writeToTerminal(data);
    },
    onSnapshot: (data: string) => {
      try {
        const decoded = atob(data);
        writeToTerminal(decoded);
      } catch {
        // ignore
      }
    },
    onStatus: (s) => {
      console.log("Status:", s);
    },
  });

  wsClient.connect();
}

function _onDisconnect() {
  wsClient?.disconnect();
  wsClient = null;
  _connected = false;
  status = "disconnected";
}

onMount(() => {
  if (!showSetup && token) {
    onConnect();
  }
});

// 当 terminalContainer 可用时初始化 xterm
$effect(() => {
  if (terminalContainer) {
    createTerminal(terminalContainer, {
      fontSize: 14,
      onData: (data) => {
        wsClient?.sendInput(data);
      },
      onResize: (cols, rows) => {
        wsClient?.sendResize(cols, rows);
      },
    });
  }
});

onDestroy(() => {
  disposeTerminal();
  wsClient?.disconnect();
});
</script>

<div>
    {#if showSetup}
        <div class="setup-screen">
            <h1>🔗 Pi WebTerm</h1>
            <p>输入 Token 连接到 Pi 编码 Agent</p>
            <input
                type="text"
                placeholder="服务器地址"
                bind:value={serverUrl}
                disabled={connected}
            />
            <input
                type="text"
                placeholder="Token"
                bind:value={token}
                disabled={connected}
            />
            {#if errorMsg}
                <div class="error">{errorMsg}</div>
            {/if}
            <button class="connect-btn" onclick={onConnect} disabled={!token}>
                {connected ? "已连接" : "连接"}
            </button>
        </div>
    {:else}
        <div class="status-bar">
            <span class="status-dot {status}"></span>
            <span class="status-text">{statusText}</span>
            <span class="session-name">pi-agent</span>
        </div>

        <div
            class="terminal-container"
            bind:this={terminalContainer}
            onclick={() => focusTerminal()}
        >
            <!-- xterm.js will mount here -->
        </div>
    {/if}
</div>
