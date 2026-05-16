import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

const DEFAULT_NVIM_ENTRYPOINT = "lua require('pi.cr').start()";
const CR_SESSION_ROOT = [".pi", "cr-diffview"];
const SELECT_LIST_MAX_VISIBLE = 10;
const SELECT_LIST_HINT = "Type to filter • Enter to select • esc to cancel";
const EMPTY_FILTER_HINT = "type to filter...";
const CR_TMUX_WINDOW_NAME_PREFIX = "pi-cr";
const CR_WIDGET_KEY = "cr-diffview";
const START_SHORTCUT = "alt+r";
const START_COMMAND = "cr-neovim-start";
const STOP_COMMAND = "cr-neovim-stop";
const CR_PRESETS = [
  {
    value: "unstaged",
    label: "Review unstaged changes",
    description: "git diff",
  },
  {
    value: "staged",
    label: "Review staged changes",
    description: "git diff --cached",
  },
  {
    value: "baseBranch",
    label: "Review against a base branch",
    description: "branch...HEAD",
  },
] as const;

type CrPresetValue = (typeof CR_PRESETS)[number]["value"];

type ExecResult = { code: number; stdout: string; stderr: string };

type CrDiffScope = {
  target: string;
  label: string;
  diffArgs: string[];
};

type CrSession = {
  sessionId: string;
  repoRoot: string;
  target: string;
  label: string;
  head: string;
  mergeBase: string;
  diffArgs: string[];
  socketPath: string;
  crSocketPath: string;
  tmuxWindowName: string;
  artifactPath: string;
  createdAt: string;
};

type CrAnnotation = {
  file: string;
  line: number;
  side?: string;
  snippet?: string;
  comment: string;
};

type WidgetContext = ExtensionCommandContext & {
  ui?: ExtensionCommandContext["ui"] & {
    setWidget?: (key: string, content?: unknown) => void;
    theme?: { fg?: (token: string, text: string) => string };
  };
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

const getTmuxEnv = (ctx: ExtensionCommandContext): string | undefined =>
  (ctx as { env?: Record<string, string | undefined> }).env?.TMUX ??
  process.env.TMUX;

export const buildCrTmuxWindowName = (repoRoot: string): string =>
  `${CR_TMUX_WINDOW_NAME_PREFIX}-${basename(repoRoot)}`;

export const buildCrTmuxNewWindowArgs = <CommandArg = string>(
  tmuxWindowName: string,
  command: CommandArg,
): Array<string | CommandArg> => [
  "new-window",
  "-a",
  "-n",
  tmuxWindowName,
  command,
];

export const buildCrTmuxKillWindowArgs = (tmuxWindowName: string): string[] => [
  "kill-window",
  "-t",
  tmuxWindowName,
];

const getCrTmuxWindowName = (session: CrSession | null): string =>
  session?.tmuxWindowName ?? CR_TMUX_WINDOW_NAME_PREFIX;

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

const getBranchCandidates = (
  branches: string[],
  currentBranch: string | null,
): string[] =>
  currentBranch
    ? branches.filter((branch) => branch !== currentBranch)
    : branches;

const buildBranchItems = (
  branches: string[],
  defaultBranch: string,
): SelectItem[] =>
  [...branches]
    .sort((left, right) => {
      if (left === defaultBranch) return -1;
      if (right === defaultBranch) return 1;
      return left.localeCompare(right);
    })
    .map((branch) => ({
      value: branch,
      label: branch,
      description: branch === defaultBranch ? "(default)" : "",
    }));

const notifyNoBranchCandidates = (
  ctx: ExtensionCommandContext,
  currentBranch: string | null,
): void => {
  ctx.ui.notify(
    currentBranch
      ? `No other branches found (current branch: ${currentBranch})`
      : "No branches found",
    "error",
  );
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
  ctx: ExtensionCommandContext,
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

const selectCrPreset = (
  ctx: ExtensionCommandContext,
): Promise<CrPresetValue | null> =>
  showSelectList<CrPresetValue>(
    ctx,
    "Select CR diff target",
    CR_PRESETS.map((preset) => ({ ...preset })),
  );

const selectTargetBranch = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | null> => {
  const [branches, currentBranch, defaultBranch] = await Promise.all([
    getLocalBranches(pi),
    getCurrentBranch(pi),
    getDefaultBranch(pi),
  ]);
  const candidateBranches = getBranchCandidates(branches, currentBranch);

  if (candidateBranches.length === 0) {
    notifyNoBranchCandidates(ctx, currentBranch);
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
    artifactPath: join(sessionDir, "annotations.jsonl"),
    createdAt: new Date().toISOString(),
  };

  writeFileSync(
    join(sessionDir, "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
  );
  return session;
};

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
    shellQuote(DEFAULT_NVIM_ENTRYPOINT),
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

type CrSocketPayload = {
  type?: string;
  annotations?: CrAnnotation[];
};

const isCrAnnotation = (value: unknown): value is CrAnnotation => {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as Partial<CrAnnotation>;
  return (
    typeof annotation.file === "string" &&
    typeof annotation.line === "number" &&
    typeof annotation.comment === "string" &&
    annotation.comment.trim().length > 0
  );
};

const parseSocketPayload = (line: string): CrSocketPayload | null => {
  try {
    return JSON.parse(line) as CrSocketPayload;
  } catch {
    return null;
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

const annotationsFromFinishPayload = (
  payload: CrSocketPayload,
): CrAnnotation[] => {
  if (payload.type !== "finish" || !Array.isArray(payload.annotations)) {
    return [];
  }
  return payload.annotations.filter(isCrAnnotation);
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

const showCrWidget = (ctx: WidgetContext, session: CrSession): void => {
  if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") return;

  const message = `🔎 CR diffview open: ${session.label} — /${STOP_COMMAND} to close`;
  const line = ctx.ui.theme?.fg?.("accent", message) ?? message;
  ctx.ui.setWidget(CR_WIDGET_KEY, [line]);
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

const formatAnnotationsPrompt = (annotations: CrAnnotation[]): string => {
  const lines = [
    "I annotated the code review diff in Neovim.",
    "Please analyze these comments and propose or apply fixes as appropriate.",
    "",
  ];

  annotations.forEach((annotation, index) => {
    lines.push(`## CR annotation ${index + 1}`);
    lines.push(`- File: ${annotation.file}`);
    lines.push(`- Line: ${annotation.line}`);
    if (annotation.side) lines.push(`- Side: ${annotation.side}`);
    if (annotation.snippet) lines.push(`- Snippet: ${annotation.snippet}`);
    lines.push("- Comment:");
    lines.push(annotation.comment);
    lines.push("");
  });

  return lines.join("\n");
};

const branchScope = (target: string): CrDiffScope => ({
  target,
  label: `${target}...HEAD`,
  diffArgs: [`${target}...HEAD`],
});

const resolveScope = async (
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<CrDiffScope | null> => {
  const target = rawArgs.trim();
  if (target) return branchScope(target);
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `/${START_COMMAND} requires interactive mode when no target is provided`,
      "error",
    );
    return null;
  }

  const preset = await selectCrPreset(ctx);
  if (preset === "staged") {
    return { target: "", label: "staged changes", diffArgs: ["--cached"] };
  }
  if (preset === "unstaged") {
    return { target: "", label: "unstaged changes", diffArgs: [] };
  }
  if (preset === "baseBranch") {
    const branch = await selectTargetBranch(pi, ctx);
    return branch ? branchScope(branch) : null;
  }
  return null;
};

export default function crDiffviewExtension(pi: ExtensionAPI): void {
  let activeSession: CrSession | null = null;

  const startHandler = async (
    args: string,
    ctx: ExtensionCommandContext,
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
    const session = await createSession(pi, repoRoot, scope);
    const crSocketServer = await startCrSocketServer(session, pi, () => {
      if (activeSession?.sessionId !== session.sessionId) return;
      activeSession = null;
      clearCrWidget(widgetCtx);
    });
    const nvimCommand = buildNvimCommand(session);
    const tmuxResult = (await pi.exec(
      "tmux",
      buildCrTmuxNewWindowArgs(session.tmuxWindowName, nvimCommand),
    )) as ExecResult;

    if (tmuxResult.code !== 0) {
      closeCrSocketServer(crSocketServer, session.crSocketPath);
      clearCrWidget(widgetCtx);
      ctx.ui.notify(
        tmuxResult.stderr.trim() || "Failed to open CR Neovim window",
        "error",
      );
      return;
    }

    activeSession = session;
    showCrWidget(widgetCtx, session);
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

      const tmuxResult = (await pi.exec(
        "tmux",
        buildCrTmuxKillWindowArgs(getCrTmuxWindowName(activeSession)),
      )) as ExecResult;

      activeSession = null;
      clearCrWidget(widgetCtx);

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
