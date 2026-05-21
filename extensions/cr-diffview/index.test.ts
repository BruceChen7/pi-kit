import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_WATCHER_CONTROL_CHANNEL } from "../shared/internal-events.ts";

import crDiffviewExtension, {
  buildCrTmuxKillWindowArgs,
  buildCrTmuxNewWindowArgs,
  buildCrTmuxSelectPaneArgs,
  buildCrTmuxWindowName,
} from "./index.ts";

beforeEach(() => {
  vi.stubEnv("TMUX", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type CommandHandler = (
  args: string,
  ctx: Record<string, unknown>,
) => Promise<void>;

type ShortcutHandler = (ctx: Record<string, unknown>) => Promise<void>;
type InputHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => { action: string };

type ExecResult = { code: number; stdout: string; stderr: string };

const START_COMMAND = "cr-neovim-start";
const STOP_COMMAND = "cr-neovim-stop";
const START_SHORTCUT = "alt+r";
const TMUX_ENV = "/tmp/tmux";

const createRepoRoot = (): string =>
  mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));

type TestContextOptions = {
  repoRoot?: string;
  hasUI?: boolean;
  tmux?: boolean;
  tmuxPane?: string;
  ui?: Record<string, unknown>;
};

const createTestContext = ({
  repoRoot = "/repo",
  hasUI = true,
  tmux = true,
  tmuxPane,
  ui = {},
}: TestContextOptions = {}) => {
  const notify = vi.fn();
  const setWidget = vi.fn();
  const env: Record<string, string> = {};
  if (tmux) env.TMUX = TMUX_ENV;
  if (tmuxPane) env.TMUX_PANE = tmuxPane;

  return {
    ctx: {
      cwd: repoRoot,
      hasUI,
      env,
      ui: { notify, setWidget, ...ui },
    },
    notify,
    setWidget,
  };
};

const registerCrCommands = (exec: ReturnType<typeof vi.fn>) => {
  const commands = new Map<string, CommandHandler>();
  const shortcuts = new Map<string, ShortcutHandler>();
  const events = new Map<string, InputHandler>();
  const internalEvents = { emit: vi.fn() };
  const sendUserMessage = vi.fn();
  crDiffviewExtension({
    exec,
    events: internalEvents,
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
    registerShortcut(shortcut, definition) {
      shortcuts.set(String(shortcut), definition.handler);
    },
    on(name, handler) {
      events.set(String(name), handler as InputHandler);
    },
    sendUserMessage,
  } as unknown as ExtensionAPI);

  const startHandler = commands.get(START_COMMAND);
  const stopHandler = commands.get(STOP_COMMAND);
  const startShortcutHandler = shortcuts.get(START_SHORTCUT);
  const inputHandler = events.get("input");
  expect(startHandler).toBeTypeOf("function");
  expect(stopHandler).toBeTypeOf("function");
  expect(startShortcutHandler).toBeTypeOf("function");
  expect(inputHandler).toBeTypeOf("function");
  return {
    startHandler: startHandler as CommandHandler,
    stopHandler: stopHandler as CommandHandler,
    startShortcutHandler: startShortcutHandler as ShortcutHandler,
    inputHandler: inputHandler as InputHandler,
    sendUserMessage,
    internalEvents,
  };
};

const tmuxArgsFromExec = (exec: ReturnType<typeof vi.fn>): unknown[] =>
  exec.mock.calls.find((call) => call[0] === "tmux")?.[1] ?? [];

const tmuxCommandFromExec = (exec: ReturnType<typeof vi.fn>): string =>
  String(
    tmuxArgsFromExec(exec).find((arg) => String(arg).includes("nvim --listen")),
  );

const expectTmuxNewWindowStarted = (
  exec: ReturnType<typeof vi.fn>,
  repoRoot: string,
): void => {
  expect(exec).toHaveBeenCalledWith(
    "tmux",
    buildCrTmuxNewWindowArgs(
      buildCrTmuxWindowName(repoRoot),
      expect.stringContaining("nvim --listen"),
    ),
  );
};

const expectFileWatcherControlEvent = (
  emit: ReturnType<typeof vi.fn>,
  type: "file-watcher.start" | "file-watcher.stop",
  repoRoot: string,
): void => {
  expect(emit).toHaveBeenCalledWith(
    FILE_WATCHER_CONTROL_CHANNEL,
    expect.objectContaining({
      type,
      path: repoRoot,
      source: "cr-diffview",
    }),
  );
};

const socketFromTmuxCommand = (exec: ReturnType<typeof vi.fn>): string => {
  // Matches the CR_SOCKET env assignment embedded in the tmux shell command.
  const match = tmuxCommandFromExec(exec).match(/CR_SOCKET='([^']+)'/);
  expect(match?.[1]).toBeTruthy();
  return match?.[1] ?? "";
};

const sessionDirFromTmuxCommand = (exec: ReturnType<typeof vi.fn>): string => {
  // Captures the generated session directory from the nvim --listen socket path.
  const match = tmuxCommandFromExec(exec).match(
    /--listen '([^']+)\/nvim\.sock'/,
  );
  expect(match?.[1]).toBeTruthy();
  return match?.[1] ?? "";
};

const exchangeSocketMessages = (
  socketPath: string,
  payloads: unknown[],
): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const responses: string[] = [];
    let buffered = "";
    const client = net.createConnection(socketPath, () => {
      for (const payload of payloads) {
        client.write(`${JSON.stringify(payload)}\n`);
      }
      client.end();
    });
    client.on("data", (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      responses.push(...lines.filter(Boolean));
    });
    client.on("error", reject);
    client.on("close", () => resolve(responses));
  });

const createCrExec = (
  repoRoot: string,
  tmuxResult: ExecResult = { code: 0, stdout: "", stderr: "" },
) => {
  const results = new Map<string, ExecResult>([
    [
      "git rev-parse --show-toplevel",
      { code: 0, stdout: `${repoRoot}\n`, stderr: "" },
    ],
    ["command -v nvim", { code: 0, stdout: "/usr/bin/nvim\n", stderr: "" }],
    ["git rev-parse HEAD", { code: 0, stdout: "head-sha\n", stderr: "" }],
    [
      "git merge-base main HEAD",
      { code: 0, stdout: "merge-base-sha\n", stderr: "" },
    ],
    [
      "git branch --format=%(refname:short)",
      { code: 0, stdout: "feature\nmain\ndev\n", stderr: "" },
    ],
    ["git branch --show-current", { code: 0, stdout: "feature\n", stderr: "" }],
    [
      "git symbolic-ref refs/remotes/origin/HEAD --short",
      { code: 0, stdout: "origin/main\n", stderr: "" },
    ],
  ]);

  return vi.fn(async (command: string, args: string[]) => {
    if (command === "tmux") return tmuxResult;
    return (
      results.get(`${command} ${args.join(" ")}`) ?? {
        code: 0,
        stdout: "",
        stderr: "",
      }
    );
  });
};

type StartedCrReviewOptions = {
  args?: string;
  repoRoot?: string;
  tmuxPane?: string;
  ui?: Record<string, unknown>;
};

const startCrReview = async ({
  args = "main",
  repoRoot = createRepoRoot(),
  tmuxPane,
  ui,
}: StartedCrReviewOptions = {}) => {
  const exec = createCrExec(repoRoot);
  const handlers = registerCrCommands(exec);
  const testContext = createTestContext({ repoRoot, tmuxPane, ui });

  await handlers.startHandler(args, testContext.ctx);

  return { repoRoot, exec, ...handlers, ...testContext };
};

describe("cr-diffview command", () => {
  it(`registers /${START_COMMAND} and reports a clear error outside git repositories`, async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const { ctx, notify } = createTestContext();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("", ctx);

    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"]);
    expect(notify).toHaveBeenCalledWith(
      `/${START_COMMAND} requires a git repository`,
      "error",
    );
  });

  it("requires tmux before starting Neovim", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "/repo\n", stderr: "" });
    const { ctx, notify } = createTestContext({ tmux: false });
    const { startHandler } = registerCrCommands(exec);

    await startHandler("main", ctx);

    expect(notify).toHaveBeenCalledWith(
      `/${START_COMMAND} requires tmux`,
      "error",
    );
  });

  it("opens a direct target diff in a new tmux Neovim window", async () => {
    const { exec, notify, repoRoot } = await startCrReview();

    expectTmuxNewWindowStarted(exec, repoRoot);
    expect(tmuxCommandFromExec(exec)).toContain("CR_SOCKET='");
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for main...HEAD",
      "info",
    );
  });

  it("starts file-watcher for the repo after opening CR diffview", async () => {
    const { internalEvents, repoRoot } = await startCrReview();

    expectFileWatcherControlEvent(
      internalEvents.emit,
      "file-watcher.start",
      repoRoot,
    );
  });

  it("clears the widget when the user submits input", async () => {
    const { ctx, inputHandler, internalEvents, repoRoot, setWidget } =
      await startCrReview();

    internalEvents.emit.mockClear();
    inputHandler({ source: "user" }, ctx);

    expect(setWidget).toHaveBeenCalledWith("cr-diffview", undefined);
    expectFileWatcherControlEvent(
      internalEvents.emit,
      "file-watcher.stop",
      repoRoot,
    );
  });

  it("keeps the widget for extension-sourced input", async () => {
    const { ctx, inputHandler, internalEvents, setWidget } =
      await startCrReview();

    setWidget.mockClear();
    internalEvents.emit.mockClear();
    inputHandler({ source: "extension" }, ctx);

    expect(setWidget).not.toHaveBeenCalled();
    expect(internalEvents.emit).not.toHaveBeenCalled();
  });

  it("opens the interactive CR diff target picker from the start shortcut", async () => {
    const repoRoot = createRepoRoot();
    const exec = createCrExec(repoRoot);
    const custom = vi.fn(async () => "staged");
    const { ctx, notify } = createTestContext({ repoRoot, ui: { custom } });
    const { startShortcutHandler } = registerCrCommands(exec);

    await startShortcutHandler(ctx);

    expect(custom).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for staged changes",
      "info",
    );
  });

  it("accepts CR annotations through the CR socket", async () => {
    const { exec, sendUserMessage } = await startCrReview();

    const responses = await exchangeSocketMessages(
      socketFromTmuxCommand(exec),
      [
        { type: "hello" },
        {
          type: "finish",
          annotations: [
            {
              file: "src/a.ts",
              line: 7,
              snippet: "const value = 1",
              comment: "Please rename this.",
            },
          ],
        },
      ],
    );

    expect(JSON.parse(responses[0])).toEqual(
      expect.objectContaining({
        type: "config",
        diffArgs: ["main...HEAD"],
        target: "main",
      }),
    );

    await vi.waitFor(() => {
      expect(sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please rename this."),
        { deliverAs: "followUp" },
      );
    });
  });

  it("clears the widget when CR annotations finish through the socket", async () => {
    const { exec, internalEvents, repoRoot, setWidget } = await startCrReview();

    internalEvents.emit.mockClear();

    await exchangeSocketMessages(socketFromTmuxCommand(exec), [
      { type: "hello" },
      {
        type: "finish",
        annotations: [
          {
            file: "src/a.ts",
            line: 7,
            comment: "Looks good after this change.",
          },
        ],
      },
    ]);

    await vi.waitFor(() => {
      expect(setWidget).toHaveBeenCalledWith("cr-diffview", undefined);
    });
    expectFileWatcherControlEvent(
      internalEvents.emit,
      "file-watcher.stop",
      repoRoot,
    );
  });

  it("returns focus to the tmux pane that started the CR review", async () => {
    const { exec } = await startCrReview({ tmuxPane: "%42" });

    await exchangeSocketMessages(socketFromTmuxCommand(exec), [
      { type: "hello" },
      { type: "finish", annotations: [] },
    ]);

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith(
        "tmux",
        buildCrTmuxSelectPaneArgs("%42"),
      );
    });
  });

  it("does not crash when the CR socket peer closes before config is written", async () => {
    const { exec, notify } = await startCrReview();

    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socketFromTmuxCommand(exec), () => {
        client.write(`${JSON.stringify({ type: "hello" })}\n`);
        client.destroy();
        resolve();
      });
      client.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for main...HEAD",
      "info",
    );
  });

  it("stops the tmux Neovim CR window", async () => {
    const exec = createCrExec("/repo");
    const { ctx, notify } = createTestContext();
    const { stopHandler } = registerCrCommands(exec);

    await stopHandler("", ctx);

    expect(exec).toHaveBeenCalledWith(
      "tmux",
      buildCrTmuxKillWindowArgs("pi-cr"),
    );
    expect(notify).toHaveBeenCalledWith("Closed CR Neovim window", "info");
  });

  it("clears the widget even when stopping the CR Neovim window fails", async () => {
    const exec = createCrExec("/repo", {
      code: 1,
      stdout: "",
      stderr: "can't find window: pi-cr",
    });
    const { ctx, notify, setWidget } = createTestContext();
    const { stopHandler } = registerCrCommands(exec);

    await stopHandler("", ctx);

    expect(setWidget).toHaveBeenCalledWith("cr-diffview", undefined);
    expect(notify).toHaveBeenCalledWith("can't find window: pi-cr", "error");
  });

  it("sends saved annotations before stopping the CR Neovim window", async () => {
    const {
      ctx,
      exec,
      internalEvents,
      repoRoot,
      sendUserMessage,
      setWidget,
      stopHandler,
    } = await startCrReview();

    writeFileSync(
      join(sessionDirFromTmuxCommand(exec), "annotations.jsonl"),
      `${JSON.stringify({
        file: "src/a.ts",
        line: 7,
        comment: "Please preserve this feedback.",
      })}\n`,
    );

    await stopHandler("", ctx);

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Please preserve this feedback."),
      { deliverAs: "followUp" },
    );
    expect(setWidget).toHaveBeenCalledWith("cr-diffview", undefined);
    expectFileWatcherControlEvent(
      internalEvents.emit,
      "file-watcher.stop",
      repoRoot,
    );
  });

  it("selects a target branch by typing to filter interactively", async () => {
    const repoRoot = createRepoRoot();
    const exec = createCrExec(repoRoot);
    const custom = vi
      .fn()
      .mockResolvedValueOnce("baseBranch")
      .mockImplementationOnce(async (renderPicker) => {
        let selected: string | null = null;
        const picker = renderPicker(
          { requestRender: vi.fn() },
          {
            bold: (text: string) => text,
            fg: (_token: string, text: string) => text,
          },
          {},
          (value: string | null) => {
            selected = value;
          },
        );

        expect(picker.render(80).join("\n")).toContain("Filter:");
        for (const input of ["m", "backspace", "d"]) {
          picker.handleInput(input);
        }
        expect(picker.render(80).join("\n")).toContain("Filter: d");
        picker.handleInput("\r");
        return selected;
      });
    const { ctx, notify } = createTestContext({ repoRoot, ui: { custom } });
    const { startHandler } = registerCrCommands(exec);

    await startHandler("", ctx);

    expect(custom).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for dev...HEAD",
      "info",
    );
  });
});
