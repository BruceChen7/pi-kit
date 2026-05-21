import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import {
  FILE_WATCHER_CONTROL_CHANNEL,
  type PiKitFileWatcherControlEvent,
} from "../shared/internal-events.ts";
import {
  annotationsFromFinishPayload,
  branchScope,
  buildBranchItems,
  buildCrTmuxKillWindowArgs,
  buildCrTmuxNewWindowArgs,
  buildCrTmuxSelectPaneArgs,
  buildCrTmuxWindowName,
  buildNoBranchCandidatesMessage,
  CR_PRESETS,
  CR_WIDGET_KEY,
  type CrAnnotation,
  type CrDiffScope,
  type CrPresetValue,
  type CrSession,
  decideScopeFromPreset,
  decideScopeResolution,
  formatAnnotationsPrompt,
  getBranchCandidates,
  getCrTmuxWindowName,
  parseSocketPayload,
  START_COMMAND,
  STOP_COMMAND,
} from "./core.ts";

export {
  buildCrTmuxKillWindowArgs,
  buildCrTmuxNewWindowArgs,
  buildCrTmuxSelectPaneArgs,
  buildCrTmuxWindowName,
} from "./core.ts";

const CR_SESSION_ROOT = [".pi", "cr-diffview"];
const SELECT_LIST_MAX_VISIBLE = 10;
const SELECT_LIST_HINT = "Type to filter • Enter to select • esc to cancel";
const EMPTY_FILTER_HINT = "type to filter...";
const START_SHORTCUT = "alt+r";
const CR_FILE_WATCHER_SOURCE = "cr-diffview";

type ExecResult = { code: number; stdout: string; stderr: string };

type WidgetContext = ExtensionContext & {
  ui?: ExtensionContext["ui"] & {
    setWidget?: (key: string, content?: unknown) => void;
    theme?: { fg?: (token: string, text: string) => string };
  };
};

type EventBus = {
  emit?: (channel: string, payload: unknown) => void;
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const getRepoRoot = async (pi: ExtensionAPI): Promise<string | null> => {
  const { code, stdout } = await pi.exec("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (code !== 0 || !stdout.trim()) {
    return null;
  }
  return stdout.trim();
};

const execOk = async (
  pi: ExtensionAPI,
  command: string,
  args: string[],
): Promise<boolean> => {
  const { code } = (await pi.exec(command, args)) as ExecResult;
  return code === 0;
};

const gitOutput = async (pi: ExtensionAPI, args: string[]): Promise<string> => {
  const { code, stdout } = (await pi.exec("git", args)) as ExecResult;
  return code === 0 ? stdout.trim() : "";
};

const getTmuxEnv = (ctx: ExtensionContext): string | undefined =>
  (ctx as { env?: Record<string, string | undefined> }).env?.TMUX ??
  process.env.TMUX;

const getTmuxPaneEnv = (ctx: ExtensionContext): string =>
  (ctx as { env?: Record<string, string | undefined> }).env?.TMUX_PANE ??
  process.env.TMUX_PANE ??
  "";

const buildSelectListTheme = (theme: {
  fg: (token: string, text: string) => string;
}) => ({
  selectedPrefix: (text: string) => theme.fg("accent", text),
  selectedText: (text: string) => theme.fg("accent", text),
  description: (text: string) => theme.fg("muted", text),
  scrollInfo: (text: string) => theme.fg("dim", text),
  noMatch: (text: string) => theme.fg("warning", text),
});

const getLocalBranches = async (pi: ExtensionAPI): Promise<string[]> => {
  const { code, stdout } = (await pi.exec("git", [
    "branch",
    "--format=%(refname:short)",
  ])) as ExecResult;
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean);
};

const getCurrentBranch = async (pi: ExtensionAPI): Promise<string | null> => {
  const { code, stdout } = (await pi.exec("git", [
    "branch",
    "--show-current",
  ])) as ExecResult;
  return code === 0 && stdout.trim() ? stdout.trim() : null;
};

const getDefaultBranch = async (pi: ExtensionAPI): Promise<string> => {
  const { code, stdout } = (await pi.exec("git", [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "--short",
  ])) as ExecResult;
  if (code === 0 && stdout.trim()) {
    return stdout.trim().replace("origin/", "");
  }

  const branches = await getLocalBranches(pi);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return "main";
};

const isBackspaceInput = (data: string): boolean =>
  data === "backspace" || matchesKey(data, "backspace");

const isPrintableInput = (data: string): boolean => {
  const chars = Array.from(data);
  if (chars.length !== 1) return false;
  const codePoint = chars[0]?.codePointAt(0) ?? 0;
  return codePoint >= 32 && codePoint !== 127;
};

const showSelectList = async <T extends string>(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
): Promise<T | null> =>
  ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
    let query = "";
    const container = new Container();
    const filterText = new Text("");
    const renderFilter = () => {
      const value = query || theme.fg("dim", EMPTY_FILTER_HINT);
      filterText.setText(`Filter: ${value}`);
    };

    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title))));
    renderFilter();
    container.addChild(filterText);

    const selectList = new SelectList(
      items,
      Math.min(items.length, SELECT_LIST_MAX_VISIBLE),
      buildSelectListTheme(theme),
    );

    selectList.onSelect = (item) => done(item.value as T);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", SELECT_LIST_HINT)));
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    const updateFilter = (nextQuery: string) => {
      query = nextQuery;
      selectList.setFilter(query);
      renderFilter();
    };

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (isBackspaceInput(data)) {
          updateFilter(query.slice(0, -1));
        } else if (isPrintableInput(data)) {
          updateFilter(`${query}${data}`);
        } else {
          selectList.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });

const selectCrPreset = (ctx: ExtensionContext): Promise<CrPresetValue | null> =>
  showSelectList<CrPresetValue>(
    ctx,
    "Select CR diff target",
    CR_PRESETS.map((preset) => ({ ...preset })),
  );

const selectTargetBranch = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null> => {
  const [branches, currentBranch, defaultBranch] = await Promise.all([
    getLocalBranches(pi),
    getCurrentBranch(pi),
    getDefaultBranch(pi),
  ]);
  const candidateBranches = getBranchCandidates(branches, currentBranch);

  if (candidateBranches.length === 0) {
    ctx.ui.notify(buildNoBranchCandidatesMessage(currentBranch), "error");
    return null;
  }

  return showSelectList<string>(
    ctx,
    "Select base branch",
    buildBranchItems(candidateBranches, defaultBranch),
  );
};

const createSession = async (
  pi: ExtensionAPI,
  repoRoot: string,
  scope: CrDiffScope,
  originTmuxPane: string,
): Promise<CrSession> => {
  const sessionId = `cr-${Date.now()}`;
  const sessionDir = join(repoRoot, ...CR_SESSION_ROOT, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const session = {
    sessionId,
    repoRoot,
    target: scope.target,
    label: scope.label,
    head: await gitOutput(pi, ["rev-parse", "HEAD"]),
    mergeBase: scope.target
      ? await gitOutput(pi, ["merge-base", scope.target, "HEAD"])
      : "",
    diffArgs: scope.diffArgs,
    socketPath: join(sessionDir, "nvim.sock"),
    crSocketPath: join(tmpdir(), `${sessionId}.sock`),
    tmuxWindowName: buildCrTmuxWindowName(repoRoot),
    originTmuxPane,
    artifactPath: join(sessionDir, "annotations.jsonl"),
    createdAt: new Date().toISOString(),
  };

  writeFileSync(
    join(sessionDir, "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
  );
  return session;
};

const luaString = (value: string): string => JSON.stringify(value);

const buildNvimEntrypoint = (): string =>
  ["lua", `require(${luaString("pi.cr")}).start()`].join(" ");

const buildNvimCommand = (session: CrSession): string => {
  const env = `CR_SOCKET=${shellQuote(session.crSocketPath)}`;
  return [
    "cd",
    shellQuote(session.repoRoot),
    "&&",
    env,
    "nvim",
    "--listen",
    shellQuote(session.socketPath),
    "-c",
    shellQuote(buildNvimEntrypoint()),
  ].join(" ");
};

const readArtifactAnnotations = (artifactPath: string): CrAnnotation[] => {
  try {
    return readFileSync(artifactPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CrAnnotation)
      .filter((annotation) => annotation.comment?.trim());
  } catch {
    return [];
  }
};

const writeSocketMessage = (socket: net.Socket, payload: unknown): void => {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(payload)}\n`, (error) => {
    if (error) {
      socket.destroy();
    }
  });
};

const writeConfigMessage = (socket: net.Socket, session: CrSession): void => {
  writeSocketMessage(socket, {
    type: "config",
    sessionId: session.sessionId,
    target: session.target,
    label: session.label,
    diffArgs: session.diffArgs,
    annotationsPath: session.artifactPath,
    nvimSocket: session.socketPath,
  });
};

const sendAnnotationsToPi = (
  pi: ExtensionAPI,
  annotations: CrAnnotation[],
): void => {
  if (annotations.length === 0) return;
  pi.sendUserMessage(formatAnnotationsPrompt(annotations), {
    deliverAs: "followUp",
  });
};

const sendArtifactAnnotationsToPi = (
  pi: ExtensionAPI,
  session: CrSession,
): void => {
  sendAnnotationsToPi(pi, readArtifactAnnotations(session.artifactPath));
};

const emitCrFileWatcherControl = (
  pi: ExtensionAPI,
  session: CrSession,
  ctx: ExtensionContext,
  type: PiKitFileWatcherControlEvent["type"],
): void => {
  const eventBus = pi.events as EventBus | undefined;
  eventBus?.emit?.(FILE_WATCHER_CONTROL_CHANNEL, {
    type,
    requestId: `cr_file_watcher_${session.sessionId}`,
    createdAt: Date.now(),
    path: session.repoRoot,
    source: CR_FILE_WATCHER_SOURCE,
    ctx,
  });
};

const showCrWidget = (ctx: WidgetContext, session: CrSession): boolean => {
  if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") return false;

  const message = `🔎 CR diffview open: ${session.label} — /${STOP_COMMAND} to close`;
  const line = ctx.ui.theme?.fg?.("accent", message) ?? message;
  ctx.ui.setWidget(CR_WIDGET_KEY, [line]);
  return true;
};

const clearCrWidget = (ctx: WidgetContext): void => {
  if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") return;
  ctx.ui.setWidget(CR_WIDGET_KEY, undefined);
};

const closeCrSocketServer = (server: net.Server, socketPath: string): void => {
  server.close();
  rmSync(socketPath, { force: true });
};

const startCrSocketServer = async (
  session: CrSession,
  pi: ExtensionAPI,
  onFinish?: () => void,
): Promise<net.Server> => {
  rmSync(session.crSocketPath, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {
      socket.destroy();
    });
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const payload = parseSocketPayload(line.trim());
        if (payload?.type === "hello") {
          writeConfigMessage(socket, session);
          continue;
        }
        if (payload?.type === "finish") {
          sendAnnotationsToPi(pi, annotationsFromFinishPayload(payload));
          if (session.originTmuxPane) {
            void pi.exec(
              "tmux",
              buildCrTmuxSelectPaneArgs(session.originTmuxPane),
            );
          }
          onFinish?.();
          closeCrSocketServer(server, session.crSocketPath);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(session.crSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
};

const resolveScope = async (
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionContext,
): Promise<CrDiffScope | null> => {
  const targetDecision = decideScopeResolution(rawArgs, ctx.hasUI);
  if (targetDecision.kind === "scope") return targetDecision.scope;
  if (targetDecision.kind === "requiresInteractiveMode") {
    ctx.ui.notify(
      `/${START_COMMAND} requires interactive mode when no target is provided`,
      "error",
    );
    return null;
  }

  const presetDecision = decideScopeFromPreset(await selectCrPreset(ctx));
  if (presetDecision.kind === "scope") return presetDecision.scope;
  if (presetDecision.kind === "needsBranchSelection") {
    const branch = await selectTargetBranch(pi, ctx);
    return branch ? branchScope(branch) : null;
  }
  return null;
};

export default function crDiffviewExtension(pi: ExtensionAPI): void {
  let activeSession: CrSession | null = null;
  let crWidgetVisible = false;
  let crWatcherSessionId: string | null = null;

  const clearVisibleCrWidget = (ctx: WidgetContext): void => {
    clearCrWidget(ctx);
    crWidgetVisible = false;
  };

  const startCrFileWatcher = (
    session: CrSession,
    ctx: ExtensionContext,
  ): void => {
    emitCrFileWatcherControl(pi, session, ctx, "file-watcher.start");
    crWatcherSessionId = session.sessionId;
  };

  const stopCrFileWatcher = (
    session: CrSession | null,
    ctx: ExtensionContext,
  ): void => {
    if (!session || crWatcherSessionId !== session.sessionId) return;
    emitCrFileWatcherControl(pi, session, ctx, "file-watcher.stop");
    crWatcherSessionId = null;
  };

  const startHandler = async (
    args: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const repoRoot = await getRepoRoot(pi);
    if (!repoRoot) {
      ctx.ui.notify(`/${START_COMMAND} requires a git repository`, "error");
      return;
    }

    if (!getTmuxEnv(ctx)) {
      ctx.ui.notify(`/${START_COMMAND} requires tmux`, "error");
      return;
    }

    if (!(await execOk(pi, "command", ["-v", "nvim"]))) {
      ctx.ui.notify(`/${START_COMMAND} requires nvim`, "error");
      return;
    }

    const scope = await resolveScope(pi, args, ctx);
    if (!scope) return;

    const widgetCtx = ctx as WidgetContext;
    const session = await createSession(
      pi,
      repoRoot,
      scope,
      getTmuxPaneEnv(ctx),
    );
    const crSocketServer = await startCrSocketServer(session, pi, () => {
      if (activeSession?.sessionId !== session.sessionId) return;
      stopCrFileWatcher(session, widgetCtx);
      activeSession = null;
      clearVisibleCrWidget(widgetCtx);
    });
    const nvimCommand = buildNvimCommand(session);
    const tmuxResult = (await pi.exec(
      "tmux",
      buildCrTmuxNewWindowArgs(session.tmuxWindowName, nvimCommand),
    )) as ExecResult;

    if (tmuxResult.code !== 0) {
      closeCrSocketServer(crSocketServer, session.crSocketPath);
      clearVisibleCrWidget(widgetCtx);
      ctx.ui.notify(
        tmuxResult.stderr.trim() || "Failed to open CR Neovim window",
        "error",
      );
      return;
    }

    activeSession = session;
    crWidgetVisible = showCrWidget(widgetCtx, session);
    startCrFileWatcher(session, widgetCtx);
    sendArtifactAnnotationsToPi(pi, session);
    ctx.ui.notify(`Opened CR diffview for ${session.label}`, "info");
  };

  pi.registerCommand(START_COMMAND, {
    description: "Open a tmux Neovim diffview code review workflow",
    handler: startHandler,
  });

  pi.registerShortcut(START_SHORTCUT, {
    description: "Open a tmux Neovim diffview code review workflow (Alt+R)",
    handler: (ctx) => startHandler("", ctx),
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && crWidgetVisible) {
      stopCrFileWatcher(activeSession, ctx as ExtensionContext);
      clearVisibleCrWidget(ctx as WidgetContext);
    }

    return { action: "continue" };
  });

  pi.registerCommand(STOP_COMMAND, {
    description: "Close the tmux Neovim code review window",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!getTmuxEnv(ctx)) {
        ctx.ui.notify(`/${STOP_COMMAND} requires tmux`, "error");
        return;
      }

      const widgetCtx = ctx as WidgetContext;
      if (activeSession) {
        sendArtifactAnnotationsToPi(pi, activeSession);
      }
      stopCrFileWatcher(activeSession, ctx);

      const tmuxResult = (await pi.exec(
        "tmux",
        buildCrTmuxKillWindowArgs(getCrTmuxWindowName(activeSession)),
      )) as ExecResult;

      activeSession = null;
      clearVisibleCrWidget(widgetCtx);

      if (tmuxResult.code !== 0) {
        ctx.ui.notify(
          tmuxResult.stderr.trim() || "Failed to close CR Neovim window",
          "error",
        );
        return;
      }

      ctx.ui.notify("Closed CR Neovim window", "info");
    },
  });
}
