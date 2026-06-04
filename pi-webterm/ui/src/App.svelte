<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import { api, type DirectoryInfo, type SessionInfo } from "./lib/api";
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
let _creating = $state(false);
let _attaching = $state(false); // loading state for session attach
let _deleteLoading = $state<Set<string>>(new Set()); // set of session names being deleted

// Workspace / directory discovery
let _directories: DirectoryInfo[] = $state([]);
let _loadingDirs = $state(false);
let _loadingBranches = $state(false); // lazy branch load in progress
let _branchLoadingDir = $state("");   // which dir is currently loading branches

// Create form — directory & branch
let _directorySearch = $state(""); // search/filter input for directory list
let _selectedDirectoryPath = $state(""); // selected cwd path
let _availableBranches: string[] = $state([]);
let _createBranch = $state("");
let _createNewBranchMode = $state(false); // show new-branch input
let _createNewBranchName = $state(""); // new branch name when creating
let _baseBranch = $state(""); // base branch for new branch creation

const _filteredDirectories = $derived(
  _directories.filter(
    (d) =>
      !_directorySearch ||
      d.name.toLowerCase().includes(_directorySearch.toLowerCase()) ||
      d.path.toLowerCase().includes(_directorySearch.toLowerCase()),
  ),
);

const _selectedDirectory = $derived(
  _directories.find((d) => d.path === _selectedDirectoryPath) ?? null,
);

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

// ─── Session Display ──────────────────────────────────────────

/**
 * Compute the set of (dirname+branch) keys that have multiple sessions.
 * These sessions need hash suffix to disambiguate.
 */
const _ambiguousKeys = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const key = `${s.dirname}__${s.branch}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ambiguous = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) ambiguous.add(key);
  }
  return ambiguous;
});

/**
 * Format a session's display name.
 * Shows hash suffix only when multiple sessions share the same dirname+branch.
 */
function formatSessionLabel(session: SessionInfo): string {
  const key = `${session.dirname}__${session.branch}`;
  const needsHash = _ambiguousKeys.has(key) && session.hash;
  return needsHash
    ? `${session.dirname} [${session.hash}] / ${session.branch}`
    : `${session.dirname} / ${session.branch}`;
}

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

    // Determine branch: new branch name or selected branch
    const branch = _createNewBranchMode
      ? _createNewBranchName.trim()
      : _createBranch;
    const baseBranch = _createNewBranchMode ? _baseBranch : undefined;

    if (!_selectedDirectoryPath) {
      _errorMsg = "请选择或输入工作目录";
      _creating = false;
      return;
    }
    if (!branch) {
      _errorMsg = "请选择或输入分支名";
      _creating = false;
      return;
    }

    const result = await api.createSession(authToken, {
      cwd: _selectedDirectoryPath,
      branch: branch || undefined,
      baseBranch,
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
  _selectedDirectoryPath = "";
  _directorySearch = "";
  _availableBranches = [];
  _createBranch = "";
  _createNewBranchMode = false;
  _createNewBranchName = "";
  _baseBranch = "";
  _showCreateForm = true;
  _showSessionPicker = false;
  _loadDirectories();
}

async function _loadDirectories() {
  _loadingDirs = true;
  try {
    const result = await api.listDirectories(authToken);
    _directories = result.directories;
  } catch {
    // silently fail — user can still type a path manually
  } finally {
    _loadingDirs = false;
  }
}

async function _onSelectDirectory(dir: DirectoryInfo) {
  _selectedDirectoryPath = dir.path;
  _directorySearch = "";
  _createNewBranchMode = false;
  _createNewBranchName = "";

  // If branches haven't been fetched yet (lazy from cache/refresh), fetch on demand
  if (dir.branches.length === 0) {
    _loadingBranches = true;
    _branchLoadingDir = dir.path;
    try {
      const result = await api.fetchRepoBranches(authToken, dir.path);
      dir.branches = result.branches;
    } catch {
      dir.branches = [];
    } finally {
      _loadingBranches = false;
      _branchLoadingDir = "";
    }
  }

  // Set available branches for the branch selector
  _availableBranches = dir.branches;

  // Auto-select main or first branch
  if (dir.branches.includes("main")) {
    _createBranch = "main";
  } else if (dir.branches.length > 0) {
    _createBranch = dir.branches[0];
  } else {
    _createBranch = "";
  }
  _baseBranch = _createBranch;
}

function _onSelectBranch(branch: string) {
  if (branch === "__new__") {
    _createNewBranchMode = true;
    _createNewBranchName = "";
    _baseBranch =
      _createBranch && _createBranch !== "__new__" ? _createBranch : "main";
    _createBranch = "";
  } else {
    _createNewBranchMode = false;
    _createBranch = branch;
    _baseBranch = branch;
  }
}

function _onBranchSelect(event: Event) {
  const target = event.currentTarget as HTMLSelectElement;
  _onSelectBranch(target.value);
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
              <div class="session-card-title">
                {session.dirname}
                {#if _ambiguousKeys.has(`${session.dirname}__${session.branch}`) && session.hash}
                  <span class="session-card-hash">[{session.hash}]</span>
                {/if}
              </div>
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
    <div class="setup-screen setup-screen-create">
      <div class="setup-shell">
        <header class="setup-header">
          <div>
            <h1>Pi WebTerm</h1>
            <p>创建新的 Session</p>
          </div>
          <button class="btn-secondary setup-header-action" onclick={() => { _showCreateForm = false; _showSessionPicker = true; }}>
            返回
          </button>
        </header>

        {#if _loadingDirs}
          <div class="loading-hint">正在扫描工作目录...</div>
        {/if}

        <div class="create-grid">
          <!-- Directory list: searchable + clickable list -->
          <section class="create-panel dir-picker" aria-label="工作目录">
            <div class="panel-heading">
              <span>工作目录</span>
              <span>{_filteredDirectories.length} 个仓库</span>
            </div>
            <input
              type="text"
              class="dir-search"
              placeholder="搜索名称或路径..."
              bind:value={_directorySearch}
            />
            <div class="dir-list">
              {#each _filteredDirectories as dir (dir.path)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="dir-item"
                  class:dir-item-selected={_selectedDirectoryPath === dir.path}
                  onclick={() => _onSelectDirectory(dir)}
                  role="button"
                  tabindex="0"
                >
                  <div class="dir-item-top">
                    <div class="dir-item-name">{dir.name}</div>
                    <div class="dir-item-branches">{dir.branches.length > 0 ? `${dir.branches.length} 分支` : "···"}</div>
                  </div>
                  <div class="dir-item-path">{dir.path}</div>
                </div>
              {:else}
                {#if !_loadingDirs}
                  <div class="dir-empty">未找到 Git 仓库</div>
                {/if}
              {/each}
            </div>
          </section>

          <section class="create-panel branch-panel" aria-label="分支设置">
            <div class="panel-heading">
              <span>分支设置</span>
              {#if _selectedDirectory}
                {#if _loadingBranches}
                  <span>正在加载分支...</span>
                {:else}
                  <span>{_availableBranches.length} 个可选</span>
                {/if}
              {/if}
            </div>

            {#if _selectedDirectory}
              <div class="selected-dir">
                <span class="selected-dir-name">{_selectedDirectory.name}</span>
                <span class="selected-dir-path">{_selectedDirectory.path}</span>
              </div>
            {:else}
              <div class="selected-dir selected-dir-empty">
                <span class="selected-dir-name">先选择一个工作目录</span>
                <span class="selected-dir-path">左侧列表支持按项目名和路径搜索</span>
              </div>
            {/if}

            {#if _selectedDirectory && !_createNewBranchMode}
              <!-- Branch selector (existing branches) -->
              <label class="field-label" for="branch-select">使用分支</label>
              {#if _loadingBranches}
                <div class="loading-hint" style="padding:0.5rem 0">正在拉取分支列表...</div>
              {:else}
              <select
                id="branch-select"
                class="branch-select"
                value={_createBranch}
                onchange={_onBranchSelect}
                disabled={_availableBranches.length === 0}
              >
                <option value="" disabled>选择分支</option>
                {#each _availableBranches as branch}
                  <option value={branch}>{branch}</option>
                {/each}
                <option value="__new__">创建新分支...</option>
              </select>
              {/if}
            {/if}

            {#if _createNewBranchMode}
              <div class="new-branch-fields">
                <label class="field-label" for="new-branch-name">新分支名</label>
                <input
                  id="new-branch-name"
                  type="text"
                  placeholder="feature/your-work"
                  bind:value={_createNewBranchName}
                />
                {#if _availableBranches.length > 0}
                  <label class="field-label" for="base-branch">基于分支</label>
                  <select id="base-branch" bind:value={_baseBranch}>
                    {#each _availableBranches as branch}
                      <option value={branch}>{branch}</option>
                    {/each}
                  </select>
                {/if}
              </div>
            {/if}

            {#if _errorMsg}
              <div class="error">{_errorMsg}</div>
            {/if}

            <div class="form-actions">
              {#if _selectedDirectory && !_createNewBranchMode}
                <button class="btn-secondary" onclick={() => _onSelectBranch("__new__")}>
                  新建分支
                </button>
              {:else if _createNewBranchMode}
                <button class="btn-secondary" onclick={() => _onSelectBranch(_baseBranch || _availableBranches[0] || "")}>
                  使用已有分支
                </button>
              {:else}
                <button class="btn-secondary" onclick={() => { _showCreateForm = false; _showSessionPicker = true; }}>
                  取消
                </button>
              {/if}
              <button
                class="connect-btn"
                onclick={_createAndAttach}
                disabled={_creating || !_selectedDirectoryPath || (!_createNewBranchMode && !_createBranch) || (_createNewBranchMode && !_createNewBranchName)}
              >
                {_creating ? "创建中..." : "创建并连接"}
              </button>
            </div>
          </section>
        </div>
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
                <span class="sidebar-item-dir">
                  {session.dirname}
                  {#if _ambiguousKeys.has(`${session.dirname}__${session.branch}`) && session.hash}
                    <span class="sidebar-item-hash">[{session.hash}]</span>
                  {/if}
                </span>
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
              {formatSessionLabel(_activeSession)}
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
