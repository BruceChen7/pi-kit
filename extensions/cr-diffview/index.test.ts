import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import crDiffviewExtension from "./index.ts";

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

type ExecResult = { code: number; stdout: string; stderr: string };

const START_COMMAND = "cr-neovim-start";
const STOP_COMMAND = "cr-neovim-stop";
const START_SHORTCUT = "alt+r";

const registerCrCommands = (exec: ReturnType<typeof vi.fn>) => {
  const commands = new Map<string, CommandHandler>();
  const shortcuts = new Map<string, ShortcutHandler>();
  const sendUserMessage = vi.fn();
  crDiffviewExtension({
    exec,
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
    registerShortcut(shortcut, definition) {
      shortcuts.set(String(shortcut), definition.handler);
    },
    sendUserMessage,
  } as unknown as ExtensionAPI);

  const startHandler = commands.get(START_COMMAND);
  const stopHandler = commands.get(STOP_COMMAND);
  const startShortcutHandler = shortcuts.get(START_SHORTCUT);
  expect(startHandler).toBeTypeOf("function");
  expect(stopHandler).toBeTypeOf("function");
  expect(startShortcutHandler).toBeTypeOf("function");
  return {
    startHandler: startHandler as CommandHandler,
    stopHandler: stopHandler as CommandHandler,
    startShortcutHandler: startShortcutHandler as ShortcutHandler,
    sendUserMessage,
  };
};

const tmuxCommandFromExec = (exec: ReturnType<typeof vi.fn>): string => {
  const args = exec.mock.calls.find((call) => call[0] === "tmux")?.[1] ?? [];
  return String(
    args.find((arg: unknown) => String(arg).includes("nvim --listen")),
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
) =>
  vi.fn(async (command: string, args: string[]) => {
    const joined = args.join(" ");
    if (command === "git" && joined === "rev-parse --show-toplevel") {
      return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
    }
    if (command === "command" && joined === "-v nvim") {
      return { code: 0, stdout: "/usr/bin/nvim\n", stderr: "" };
    }
    if (command === "git" && joined === "rev-parse HEAD") {
      return { code: 0, stdout: "head-sha\n", stderr: "" };
    }
    if (command === "git" && joined === "merge-base main HEAD") {
      return { code: 0, stdout: "merge-base-sha\n", stderr: "" };
    }
    if (command === "git" && joined === "branch --format=%(refname:short)") {
      return { code: 0, stdout: "feature\nmain\ndev\n", stderr: "" };
    }
    if (command === "git" && joined === "branch --show-current") {
      return { code: 0, stdout: "feature\n", stderr: "" };
    }
    if (
      command === "git" &&
      joined === "symbolic-ref refs/remotes/origin/HEAD --short"
    ) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (command === "tmux") {
      return tmuxResult;
    }
    return { code: 0, stdout: "", stderr: "" };
  });

describe("cr-diffview command", () => {
  it(`registers /${START_COMMAND} and reports a clear error outside git repositories`, async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const notify = vi.fn();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("", {
      cwd: "/repo",
      hasUI: true,
      ui: { notify },
    });

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
    const notify = vi.fn();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("main", {
      cwd: "/repo",
      hasUI: true,
      env: {},
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith(
      `/${START_COMMAND} requires tmux`,
      "error",
    );
  });

  it("opens a direct target diff in a new tmux Neovim window", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("main", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify },
    });

    expect(exec).toHaveBeenCalledWith("tmux", [
      "new-window",
      "-a",
      "-n",
      "pi-cr",
      expect.stringContaining("nvim --listen"),
    ]);
    const tmuxCommand = tmuxCommandFromExec(exec);
    expect(tmuxCommand).toContain("CR_SOCKET='");
    expect(tmuxCommand).not.toContain("CR_DIFF_TARGET=");
    expect(tmuxCommand).not.toContain("CR_DIFF_ARGS=");
    expect(tmuxCommand).toContain("require(");
    expect(tmuxCommand).toContain("pi.cr");
    expect(tmuxCommand).toContain(".start()");
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for main...HEAD",
      "info",
    );
  });

  it("shows a widget when the CR Neovim window starts", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const setWidget = vi.fn();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("main", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify, setWidget },
    });

    expect(setWidget).toHaveBeenCalledWith("cr-diffview", [
      expect.stringContaining("CR diffview open: main...HEAD"),
    ]);
  });

  it("opens the interactive CR diff target picker from the start shortcut", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const custom = vi.fn(async () => "staged");
    const { startShortcutHandler } = registerCrCommands(exec);

    await startShortcutHandler({
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { custom, notify },
    });

    expect(custom).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for staged changes",
      "info",
    );
  });

  it("accepts CR annotations through the CR socket", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const { startHandler, sendUserMessage } = registerCrCommands(exec);

    await startHandler("main", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify },
    });

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
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const setWidget = vi.fn();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("main", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify, setWidget },
    });

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
  });

  it("does not crash when the CR socket peer closes before config is written", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const { startHandler } = registerCrCommands(exec);

    await startHandler("main", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify },
    });

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

  it("selects staged changes interactively when no target is provided", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const custom = vi.fn(async () => "staged");
    const { startHandler } = registerCrCommands(exec);

    await startHandler("", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { custom, notify },
    });

    const tmuxCommand = tmuxCommandFromExec(exec);
    expect(tmuxCommand).toContain("CR_SOCKET='");
    expect(tmuxCommand).not.toContain("CR_DIFF_ARGS=");
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for staged changes",
      "info",
    );
  });

  it("stops the tmux Neovim CR window", async () => {
    const exec = createCrExec("/repo");
    const notify = vi.fn();
    const { stopHandler } = registerCrCommands(exec);

    await stopHandler("", {
      cwd: "/repo",
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify },
    });

    expect(exec).toHaveBeenCalledWith("tmux", ["kill-window", "-t", "pi-cr"]);
    expect(notify).toHaveBeenCalledWith("Closed CR Neovim window", "info");
  });

  it("clears the widget even when stopping the CR Neovim window fails", async () => {
    const exec = createCrExec("/repo", {
      code: 1,
      stdout: "",
      stderr: "can't find window: pi-cr",
    });
    const notify = vi.fn();
    const setWidget = vi.fn();
    const { stopHandler } = registerCrCommands(exec);

    await stopHandler("", {
      cwd: "/repo",
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify, setWidget },
    });

    expect(setWidget).toHaveBeenCalledWith("cr-diffview", undefined);
    expect(notify).toHaveBeenCalledWith("can't find window: pi-cr", "error");
  });

  it("sends saved annotations before stopping the CR Neovim window", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
    const setWidget = vi.fn();
    const { startHandler, stopHandler, sendUserMessage } =
      registerCrCommands(exec);

    await startHandler("main", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify, setWidget },
    });

    writeFileSync(
      join(sessionDirFromTmuxCommand(exec), "annotations.jsonl"),
      `${JSON.stringify({
        file: "src/a.ts",
        line: 7,
        comment: "Please preserve this feedback.",
      })}\n`,
    );

    await stopHandler("", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { notify, setWidget },
    });

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Please preserve this feedback."),
      { deliverAs: "followUp" },
    );
    expect(setWidget).toHaveBeenCalledWith("cr-diffview", undefined);
  });

  it("selects a target branch by typing to filter interactively", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cr-diffview-repo-"));
    const exec = createCrExec(repoRoot);
    const notify = vi.fn();
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
    const { startHandler } = registerCrCommands(exec);

    await startHandler("", {
      cwd: repoRoot,
      hasUI: true,
      env: { TMUX: "/tmp/tmux" },
      ui: { custom, notify },
    });

    expect(custom).toHaveBeenCalledTimes(2);
    const tmuxCommand = tmuxCommandFromExec(exec);
    expect(tmuxCommand).toContain("CR_SOCKET='");
    expect(tmuxCommand).not.toContain("CR_DIFF_TARGET=");
    expect(notify).toHaveBeenCalledWith(
      "Opened CR diffview for dev...HEAD",
      "info",
    );
  });
});
