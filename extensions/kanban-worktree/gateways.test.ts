import { execFile } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const loadGateway = async () => import("./gateways.js");
const AGENT_COMMAND = 'KANBAN_FEATURE_ID=afaf pi "Implement requirement: Afaf"';

function mockTmuxExecFile(windows: string[]): void {
  vi.mocked(execFile).mockImplementation((_file, args, callback) => {
    const argv = args as string[];
    if (argv[0] === "display-message") {
      callback(null, { stdout: "working\n", stderr: "" }, "");
      return {} as never;
    }
    if (argv[0] === "list-windows") {
      callback(null, { stdout: `${windows.join("\n")}\n`, stderr: "" }, "");
      return {} as never;
    }
    callback(null, { stdout: "", stderr: "" }, "");
    return {} as never;
  });
}

beforeEach(() => {
  process.env.TMUX = "/tmp/tmux-100/default,1,0";
  vi.spyOn(Date, "now").mockReturnValue(1_778_322_400_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TMUX;
});

test("launchCommand starts a new tmux window instead of typing into an existing pane", async () => {
  mockTmuxExecFile(["kw-afaf"]);
  const logger = { info: vi.fn(), error: vi.fn() };
  const { TmuxGateway } = await loadGateway();
  const gateway = new TmuxGateway("pi-kanban", logger);

  const result = await gateway.launchCommand({
    cwd: "/repo/worktree",
    windowName: "kw-afaf",
    command: AGENT_COMMAND,
  });

  const execCalls = vi.mocked(execFile).mock.calls;
  const tmuxArgs = execCalls.map(([, args]) => args as string[]);
  expect(tmuxArgs.some((args) => args[0] === "send-keys")).toBe(false);
  expect(tmuxArgs).toContainEqual([
    "new-window",
    "-t",
    "working",
    "-n",
    expect.stringMatching(/^kw-afaf-/),
    "-c",
    "/repo/worktree",
    AGENT_COMMAND,
  ]);
  expect(result.window).toMatch(/^kw-afaf-/);
});
