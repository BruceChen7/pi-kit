<script lang="ts">
import { onDestroy, onMount } from "svelte";
import {
  clearSessionToken,
  getSessionToken,
  login,
  logout,
  setSessionToken,
} from "./lib/auth";
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
let baseUrl = $state(`ws://${window.location.host}`);
let status: ConnectionStatus = $state("disconnected");
let _errorMsg = $state("");
let _connected = $state(false);

// Login form state
let authToken = $state(getSessionToken() || "");
let _loginMode = $derived(!authToken); // true = show login form
let _username = $state("");
let _password = $state("");
let _loggingIn = $state(false);

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

async function _onLogin() {
  if (!_username || !_password) return;
  _loggingIn = true;
  _errorMsg = "";

  try {
    const result = await login(baseUrl, _username, _password);
    authToken = result.token;
    setSessionToken(authToken);
    _loginMode = false;
    _username = "";
    _password = "";
    connectWs();
  } catch (err: any) {
    _errorMsg = err.message || "登录失败";
  } finally {
    _loggingIn = false;
  }
}

async function _onLogout() {
  wsClient?.disconnect();
  wsClient = null;
  _connected = false;
  status = "disconnected";
  await logout(baseUrl);
  authToken = "";
  _loginMode = true;
}

function connectWs() {
  if (!authToken) return;

  wsClient?.disconnect();

  wsClient = new WsClient({
    url: `${baseUrl}/ws`,
    token: authToken,
    onOpen: () => {
      status = "connected";
      _connected = true;
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
          ? "认证失败，请重新登录"
          : code === 4002
            ? "会话连接失败"
            : reason;
      _errorMsg = msg;
      // If auth failed, clear token and show login
      if (code === 4001) {
        clearSessionToken();
        authToken = "";
        _loginMode = true;
      }
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

onMount(() => {
  // If we already have a session token, try connecting directly
  if (authToken) {
    connectWs();
  }
});

// Initialize xterm when terminalContainer is available
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
    {#if _loginMode}
        <div class="setup-screen">
            <h1>🔗 Pi WebTerm</h1>
            <p>输入用户名和密码连接到 Pi 编码 Agent</p>
            <input
                type="text"
                placeholder="服务器地址"
                bind:value={baseUrl}
                disabled={_connected}
            />
            <input
                type="text"
                placeholder="用户名"
                bind:value={_username}
                disabled={_loggingIn}
            />
            <input
                type="password"
                placeholder="密码"
                bind:value={_password}
                disabled={_loggingIn}
            />
            {#if _errorMsg}
                <div class="error">{_errorMsg}</div>
            {/if}
            <button
                class="connect-btn"
                onclick={_onLogin}
                disabled={_loggingIn || !_username || !_password}
            >
                {_loggingIn ? "登录中..." : "登录"}
            </button>
        </div>
    {:else if !_connected}
        <div class="setup-screen">
            <h1>🔗 Pi WebTerm</h1>
            <p>正在连接...</p>
            <div class="error">{_errorMsg}</div>
        </div>
    {:else}
        <div class="status-bar">
            <span class="status-dot {status}"></span>
            <span class="status-text">{_statusText}</span>
            <span class="session-name">pi-agent</span>
            <button class="logout-btn" onclick={_onLogout}>登出</button>
        </div>

        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
        <div
            class="terminal-container"
            bind:this={terminalContainer}
            onclick={() => focusTerminal()}
            role="application"
        >
            <!-- xterm.js will mount here -->
        </div>
    {/if}
</div>
