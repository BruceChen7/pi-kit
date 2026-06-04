<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import { api, type SessionInfo } from "./lib/api";
import {
  clearSessionToken,
  getSessionToken,
  setSessionToken,
} from "./lib/auth";
import {
  SessionConnectionManager,
  type SessionTransportHandlers,
} from "./lib/session-connection-manager";
import {
  clearTerminal,
  createTerminal,
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  getTerminal,
  resetTerminal,
  writeToTerminal,
} from "./lib/terminal";
import type { ConnectionStatus } from "./lib/ws";
import "xterm/css/xterm.css";
import "./app.css";

// ─── State ─────────────────────────────────────────────────────

let terminalContainer: HTMLDivElement | undefined = $state();
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
let baseUrl = $state(`${wsProtocol}//${window.location.host}`);
let status = $state<ConnectionStatus>("disconnected");
let _errorMsg = $state("");
let _connected = $state(false);

// Auth
let authToken = $state(getSessionToken() || "");
let _loginMode = $derived(!authToken);
let _username = $state("");
let _password = $state("");
let _loggingIn = $state(false);

// Session management
let sessions: SessionInfo[] = $state([]);
let activeSessionName: string | null = $state(null);
let sessionToken: string | null = $state(null); // session-specific token for WS
let _showSessionPicker = $state(false);
let _showCreateForm = $state(false);
let _createDirname = $state("");
let _createBranch = $state("");
let _creating = $state(false);
let _attaching = $state(false); // loading state for session attach
let _deleteLoading = $state<Set<string>>(new Set()); // set of session names being deleted

let sessionManager: SessionConnectionManager | null = null;
let _restoring = $state(!!getSessionToken()); // loading guard — only active on refresh (token exists)
let _fitRaf1: number | null = null;
let _fitRaf2: number | null = null;
let _fitTimer: ReturnType<typeof setTimeout> | null = null;

const _statusText = $derived(
  status === "connected"
    ? "已连接"
    : status === "connecting"
      ? "连接中..."
      : status === "error"
        ? "连接失败"
        : "未连接",
);

const _activeSession = $derived(
  sessions.find((s) => s.name === activeSessionName) ?? null,
);

// ─── Login ────────────────────────────────────────────────────

async function _onLogin() {
  if (!_username || !_password) return;
  _loggingIn = true;
  _errorMsg = "";

  try {
    const result = await api.login(_username, _password);
    authToken = result.token;
    setSessionToken(authToken);
    sessions = result.sessions;
    _loginMode = false;
    _username = "";
    _password = "";

    if (sessions.length === 0) {
      // No sessions — auto-create
      await _createAndAttach();
    } else if (sessions.length === 1) {
      // Single session — auto-attach
      await _attachToSession(sessions[0].name);
    } else {
      // Multiple sessions — show picker
      _showSessionPicker = true;
    }
  } catch (err: any) {
    _errorMsg = err.message || "登录失败";
  } finally {
    _loggingIn = false;
  }
}

async function _onLogout() {
  disconnectWs();
  await api.logout(authToken);
  authToken = "";
  sessionToken = null;
  activeSessionName = null;
  sessions = [];
  _loginMode = true;
  clearSessionToken();
}

// ─── Session Operations ───────────────────────────────────────

async function _createAndAttach() {
  try {
    _creating = true;
    const result = await api.createSession(authToken, {
      dirname: _createDirname || undefined,
      branch: _createBranch || undefined,
    });
    sessionToken = result.sessionToken;
    activeSessionName = result.name;
    _showCreateForm = false;
    _showSessionPicker = false;
    await _refreshSessions();
    connectWs();
  } catch (err: any) {
    _errorMsg = err.message || "创建失败";
  } finally {
    _creating = false;
  }
}

async function _attachToSession(name: string): Promise<boolean> {
  if (_attaching) return false;
  _attaching = true;
  _errorMsg = "";
  try {
    const result = await api.attachToSession(authToken, name);
    sessionToken = result.sessionToken;
    activeSessionName = name;
    _showSessionPicker = false;
    _showCreateForm = false;
    await tick();
    _scheduleTerminalFit();
    connectWs();
    return true;
  } catch (err: any) {
    _errorMsg = err.message || "连接失败";
    return false;
  } finally {
    _attaching = false;
  }
}

function _scheduleTerminalFit() {
  if (_fitRaf1 !== null) {
    cancelAnimationFrame(_fitRaf1);
    _fitRaf1 = null;
  }
  if (_fitRaf2 !== null) {
    cancelAnimationFrame(_fitRaf2);
    _fitRaf2 = null;
  }
  if (_fitTimer) {
    clearTimeout(_fitTimer);
    _fitTimer = null;
  }

  const runFit = () => {
    fitTerminal();
    const t = getTerminal();
    if (t && sessionManager) {
      sessionManager.sendResize(t.cols, t.rows);
    }
  };

  _fitRaf1 = requestAnimationFrame(() => {
    _fitRaf1 = null;
    _fitRaf2 = requestAnimationFrame(() => {
      _fitRaf2 = null;
      runFit();
    });
  });

  _fitTimer = setTimeout(() => {
    _fitTimer = null;
    runFit();
  }, 120);
}

async function _switchSession(name: string) {
  if (name === activeSessionName) return;
  disconnectWs();
  await _attachToSession(name);
}

let _errorTimer: ReturnType<typeof setTimeout> | null = null;

function _clearError() {
  _errorMsg = "";
  if (_errorTimer) {
    clearTimeout(_errorTimer);
    _errorTimer = null;
  }
}

async function _deleteSession(name: string) {
  _clearError();
  _deleteLoading = new Set([..._deleteLoading, name]);
  try {
    await api.deleteSession(authToken, name);
    await _refreshSessions();
    if (activeSessionName === name) {
      disconnectWs();
      activeSessionName = null;
      sessionToken = null;
      _showSessionPicker = true;
    }
  } catch (err: any) {
    const msg = err.message || "删除失败";
    _errorMsg = msg;
    console.error("[pi-webterm] delete session failed:", name, msg, err);
    // Auto-clear error after 8 seconds
    _errorTimer = setTimeout(() => {
      _errorMsg = "";
    }, 8000);
  } finally {
    _deleteLoading = new Set([..._deleteLoading].filter((n) => n !== name));
  }
}

async function _refreshSessions() {
  try {
    sessions = await api.listSessions(authToken);
  } catch {
    // ignore
  }
}

function _openCreateForm() {
  _createDirname = "";
  _createBranch = "";
  _showCreateForm = true;
  _showSessionPicker = false;
}

function getSessionManager(): SessionConnectionManager {
  if (sessionManager) {
    return sessionManager;
  }

  const handlers: SessionTransportHandlers = {
    onOpen: () => {
      status = "connected";
      _connected = true;
      _errorMsg = "";
      fitTerminal();

      const t = getTerminal();
      if (t) {
        console.log(
          `[pi-webterm] onOpen resize: cols=${t.cols} rows=${t.rows}`,
        );
        sessionManager?.sendResize(t.cols, t.rows);
      }

      focusTerminal();
      _scheduleTerminalFit();

      // Refresh session status — during creation the server returns
      // "starting" because the shell wrapper is still sourcing rc files.
      // By the time the WebSocket attaches, the agent should be running.
      _refreshSessions();
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
        writeToTerminal(atob(data));
      } catch {
        // ignore
      }
    },
    onStatus: (s) => {
      console.log("Status:", s);
      // Server confirms the PTY attachment — ensure connection state reflects this
      if (s.connected) {
        status = "connected";
        _connected = true;
        _errorMsg = "";
      }
    },
  };

  sessionManager = new SessionConnectionManager(handlers);
  return sessionManager;
}

// ─── WebSocket ────────────────────────────────────────────────

function connectWs() {
  if (!sessionToken || !activeSessionName) return;

  // Clear the terminal before connecting to a new session.
  // This prevents:
  // 1. Old session's residual content mixing with new session
  // 2. Snapshot (200 lines of history via capture-pane) overlapping
  //    with live PTY data from tmux attach-session
  // 3. Conflicting ANSI escape sequences from two different tmux panes
  clearTerminal();
  resetTerminal();

  // Re-fit terminal to container. The container might have been resized
  // since the last connection (e.g., sidebar toggle, orientation change,
  // or the initial fit ran before the flex layout settled).
  fitTerminal();

  getSessionManager().switchSession({
    url: `${baseUrl}/ws`,
    token: sessionToken,
    sessionId: activeSessionName,
  });
}

function disconnectWs() {
  sessionManager?.disconnect();
  _connected = false;
  status = "disconnected";
}

// ─── Lifecycle ────────────────────────────────────────────────

onMount(() => {
  if (authToken) {
    // Already logged in — try to restore session
    restoreSession();
  }
});

async function restoreSession() {
  try {
    sessions = await api.listSessions(authToken);
    if (sessions.length > 0) {
      const target =
        sessions.find((s) => s.status === "running") ?? sessions[0];
      const ok = await _attachToSession(target.name);
      if (!ok) {
        _showSessionPicker = true;
      }
    } else {
      _loginMode = true;
    }
  } catch {
    _loginMode = true;
  } finally {
    _restoring = false;
  }
}

$effect(() => {
  if (terminalContainer) {
    createTerminal(terminalContainer, {
      fontSize: 14,
      onData: (data) => {
        console.log("[pi-webterm] onData -> sessionManager.sendInput", {
          data,
          codePoints: Array.from(data).map((char) => char.charCodeAt(0)),
          hasSessionManager: Boolean(sessionManager),
          status,
          activeSessionName,
        });
        sessionManager?.sendInput(data);
      },
      onResize: (cols, rows) => {
        sessionManager?.sendResize(cols, rows);
      },
    });
  }
});

onDestroy(() => {
  if (_fitRaf1 !== null) cancelAnimationFrame(_fitRaf1);
  if (_fitRaf2 !== null) cancelAnimationFrame(_fitRaf2);
  if (_fitTimer) clearTimeout(_fitTimer);
  disposeTerminal();
  disconnectWs();
  sessionManager = null;
});
</script>

<div class="app-root">
  {#if _loginMode}
    <!-- ── Login Screen ── -->
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

  {:else if _showSessionPicker}
    <!-- ── Session Picker ── -->
    <div class="setup-screen">
      <h1>🔗 Pi WebTerm</h1>
      <p>选择一个已连接的 Session</p>

      {#if _errorMsg}
        <div class="error">{_errorMsg}</div>
      {/if}

      <div class="session-picker">
        {#each sessions as session (session.name)}
          <button
            class="session-card"
            class:session-card-running={session.status === "running"}
            class:session-card-crashed={session.status === "crashed"}
            class:session-card-stopped={session.status === "stopped"}
            onclick={() => _attachToSession(session.name)}
            disabled={_attaching}
          >
            <div class="session-card-icon">
              {#if _attaching}
                <span class="status-indicator">⏳</span>
              {:else if session.status === "running"}
                <span class="status-indicator running">●</span>
              {:else if session.status === "crashed"}
                <span class="status-indicator crashed">▲</span>
              {:else if session.status === "starting"}
                <span class="status-indicator">⏳</span>
              {:else}
                <span class="status-indicator stopped">■</span>
              {/if}
            </div>
            <div class="session-card-body">
              <div class="session-card-title">{session.dirname}</div>
              <div class="session-card-meta">
                <span class="session-card-branch">{session.branch}</span>
                <span class="session-card-status">{_attaching ? "连接中..." : session.status}</span>
              </div>
            </div>
          </button>
        {/each}
      </div>

      <button class="link-btn" onclick={_openCreateForm} disabled={_attaching}>
        + 新建 Session
      </button>
    </div>

  {:else if _showCreateForm}
    <!-- ── Create Session Form ── -->
    <div class="setup-screen">
      <h1>🔗 Pi WebTerm</h1>
      <p>创建新的 Session</p>
      <input
        type="text"
        placeholder="目录名（可选，默认自动检测）"
        bind:value={_createDirname}
      />
      <input
        type="text"
        placeholder="分支名（可选，默认自动检测）"
        bind:value={_createBranch}
      />
      {#if _errorMsg}
        <div class="error">{_errorMsg}</div>
      {/if}
      <div class="form-actions">
        <button class="btn-secondary" onclick={() => { _showCreateForm = false; _showSessionPicker = true; }}>
          取消
        </button>
        <button
          class="connect-btn"
          onclick={_createAndAttach}
          disabled={_creating}
        >
          {_creating ? "创建中..." : "创建并连接"}
        </button>
      </div>
    </div>

  {:else if _restoring}
    <div class="setup-screen">
      <h1>🔗 Pi WebTerm</h1>
      <p>正在恢复 Session...</p>
      {#if _errorMsg}
        <div class="error">{_errorMsg}</div>
      {/if}
    </div>

  {:else}
    <!-- ── Main Interface: Sidebar + Terminal ── -->
    <div class="main-layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">Sessions</span>
          <button class="sidebar-btn" onclick={_openCreateForm} title="新建 Session">+</button>
        </div>

        <div class="sidebar-list">
          {#each sessions as session (session.name)}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div
              class="sidebar-item"
              class:sidebar-item-active={session.name === activeSessionName}
              class:sidebar-item-running={session.status === "running"}
              class:sidebar-item-crashed={session.status === "crashed"}
              onclick={() => _switchSession(session.name)}
              role="button"
              tabindex="0"
            >
              <span class="sidebar-item-indicator">
                {#if _deleteLoading.has(session.name)}
                  ⏳
                {:else if session.status === "running"}
                  ●
                {:else if session.status === "crashed"}
                  ▲
                {:else if session.status === "starting"}
                  ⏳
                {:else}
                  ■
                {/if}
              </span>
              <div class="sidebar-item-body">
                <span class="sidebar-item-dir">{session.dirname}</span>
                <span class="sidebar-item-branch">{session.branch}</span>
              </div>
              <button
                class="sidebar-item-del"
                class:sidebar-item-del-loading={_deleteLoading.has(session.name)}
                onclick={(e) => { e.stopPropagation(); _deleteSession(session.name); }}
                disabled={_deleteLoading.has(session.name)}
                title="删除 Session"
              >{_deleteLoading.has(session.name) ? "⏳" : "✕"}</button>
            </div>
          {/each}
        </div>

        {#if _errorMsg}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="sidebar-error" onclick={_clearError} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _clearError(); } }} role="button" tabindex="0">
            ⚠ {_errorMsg}
          </div>
        {/if}

        <div class="sidebar-footer">
          {#if _activeSession}
            <span class="sidebar-footer-status">
              {_activeSession.dirname}/{_activeSession.branch}
            </span>
            <span class="sidebar-footer-attached">{_activeSession.status}</span>
          {/if}
        </div>
      </aside>

      <div class="main-area">
        <div class="status-bar">
          <span class="status-dot {status}"></span>
          <span class="status-text">{_statusText}</span>
          <span class="session-name">{activeSessionName ?? ""}</span>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span class="sidebar-toggle" onclick={() => _showSessionPicker = true} role="button" tabindex="0">📋</span>
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
      </div>
    </div>
  {/if}
</div>
