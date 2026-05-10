import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const getNativeHostInfoMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("glimpseui", () => ({
  getNativeHostInfo: getNativeHostInfoMock,
}));

import { createGlimpseHtml, openGlimpseKanban } from "./glimpse-host.js";

const BUILT_SVELTE_SHELL = [
  "<!doctype html><html><head>",
  '<script type="module" src="/assets/app.js"></script>',
  '</head><body><div id="app"></div></body></html>',
].join("");
let dir: string;

type TestRequest = (socketPath: string, message: unknown) => Promise<unknown>;
type TestMessageHandler = (message: unknown) => void | Promise<void>;
type TestSend = (js: string) => void;

function restoreTestEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

async function writeBuiltSvelteShell(): Promise<void> {
  await writeFile(path.join(dir, "index.html"), BUILT_SVELTE_SHELL);
}

async function openKanbanWithCapturedMessageHandler(input: {
  request: TestRequest;
  send?: TestSend;
}): Promise<TestMessageHandler> {
  await writeBuiltSvelteShell();
  let messageHandler: TestMessageHandler | undefined;

  await openGlimpseKanban("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: input.request,
    openWindow: () => ({
      on: (_event, handler) => {
        messageHandler = handler;
      },
      ...(input.send ? { send: input.send } : {}),
    }),
  });

  return async (message: unknown) => messageHandler?.(message);
}

function createdIssue(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "todo-workflow:new-todo",
    originProvider: "todo-workflow",
    originId: "new-todo",
    title: "Created from UI",
    status: "in-box",
    ...overrides,
  };
}

function launchedRun(overrides: Record<string, unknown> = {}) {
  return {
    featureId: "todo-1",
    issueId: "todo-workflow:todo-1",
    originProvider: "todo-workflow",
    originId: "todo-1",
    branch: "main/todo-1",
    worktreePath: "/repo/.worktrees/todo-1",
    state: "running",
    ...overrides,
  };
}

function expectPageEvent(
  send: TestSend,
  eventName: string,
  fragments: string[] = [],
): void {
  expect(send).toHaveBeenCalledWith(expect.stringContaining(eventName));
  for (const fragment of fragments) {
    expect(send).toHaveBeenCalledWith(expect.stringContaining(fragment));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-ui-"));
  spawnMock.mockReset();
  getNativeHostInfoMock.mockReset();
  getNativeHostInfoMock.mockReturnValue({
    path: "/tmp/glimpse-host",
    platform: "darwin",
  });
  spawnMock.mockReturnValue(createMockHostProcess());
});

function createMockHostProcess() {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    on: vi.fn(),
  };
}

function writeHostMessage(
  host: ReturnType<typeof createMockHostProcess>,
  message: unknown,
): void {
  host.stdout.write(`${JSON.stringify(message)}\n`);
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("openGlimpseKanban redirects open-window stderr to a log file", async () => {
  await writeBuiltSvelteShell();
  const logPath = path.join(dir, "glimpse-stderr.log");
  let stderrOutput = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await openGlimpseKanban("/tmp/kanban.sock", {
      uiDistDir: dir,
      request: vi.fn().mockResolvedValue({ result: [] }),
      glimpseStderrLogPath: logPath,
      openWindow: () => {
        process.stderr.write("real warning\n");
        return { on: vi.fn() };
      },
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  expect(stderrOutput).toBe("");
  const log = await readFile(logPath, "utf8");
  expect(log).toContain("real warning");
});

test("openGlimpseKanban restores the original stderr write method", async () => {
  await writeBuiltSvelteShell();
  const originalWrite = process.stderr.write;

  await openGlimpseKanban("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({ result: [] }),
    openWindow: () => ({ on: vi.fn() }),
  });

  const restoredWrite = process.stderr.write;
  process.stderr.write = originalWrite;
  expect(restoredWrite).toBe(originalWrite);
});

test("openGlimpseKanban preserves redirected stderr write callbacks", async () => {
  await writeBuiltSvelteShell();
  const logPath = path.join(dir, "glimpse-stderr.log");
  const firstCallback = vi.fn();
  const secondCallback = vi.fn();

  await openGlimpseKanban("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({ result: [] }),
    glimpseStderrLogPath: logPath,
    openWindow: () => {
      process.stderr.write("real warning\n", "utf8", firstCallback);
      process.stderr.write("another warning\n", "utf8", secondCallback);
      return { on: vi.fn() };
    },
  });

  expect(firstCallback).toHaveBeenCalledOnce();
  expect(secondCallback).toHaveBeenCalledOnce();
  const log = await readFile(logPath, "utf8");
  expect(log).toContain("real warning");
  expect(log).toContain("another warning");
});

test("default Glimpse opener starts the native host with stderr ignored", async () => {
  await writeBuiltSvelteShell();
  const previousBinaryPath = process.env.GLIMPSE_BINARY_PATH;
  const previousHostPath = process.env.GLIMPSE_HOST_PATH;
  const previousRealHost = process.env.KANBAN_GLIMPSE_REAL_HOST;
  const previousLogPath = process.env.KANBAN_GLIMPSE_STDERR_LOG;
  process.env.GLIMPSE_BINARY_PATH = "/tmp/custom-glimpse-host";
  process.env.GLIMPSE_HOST_PATH = "/tmp/custom-glimpse-host-alias";
  process.env.KANBAN_GLIMPSE_REAL_HOST = "/tmp/old-real-host";
  process.env.KANBAN_GLIMPSE_STDERR_LOG = "/tmp/old-log";

  try {
    await openGlimpseKanban("/tmp/kanban.sock", {
      uiDistDir: dir,
      request: vi.fn().mockResolvedValue({ result: [] }),
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/tmp/glimpse-host",
      ["--width", "1100", "--height", "720", "--title", "Kanban Worktree"],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: false,
      },
    );
    expect(process.env.GLIMPSE_BINARY_PATH).toBe("/tmp/custom-glimpse-host");
    expect(process.env.GLIMPSE_HOST_PATH).toBe(
      "/tmp/custom-glimpse-host-alias",
    );
    expect(process.env.KANBAN_GLIMPSE_REAL_HOST).toBe("/tmp/old-real-host");
    expect(process.env.KANBAN_GLIMPSE_STDERR_LOG).toBe("/tmp/old-log");
  } finally {
    restoreTestEnv("GLIMPSE_BINARY_PATH", previousBinaryPath);
    restoreTestEnv("GLIMPSE_HOST_PATH", previousHostPath);
    restoreTestEnv("KANBAN_GLIMPSE_REAL_HOST", previousRealHost);
    restoreTestEnv("KANBAN_GLIMPSE_STDERR_LOG", previousLogPath);
  }
});

test("default Glimpse opener bridges host JSONL messages to daemon requests", async () => {
  await writeBuiltSvelteShell();
  const host = createMockHostProcess();
  spawnMock.mockReturnValue(host);
  const request = vi.fn().mockResolvedValue({ result: [] });

  await openGlimpseKanban("/tmp/kanban.sock", {
    uiDistDir: dir,
    request,
  });

  writeHostMessage(host, { type: "ready" });
  writeHostMessage(host, {
    type: "message",
    data: {
      type: "launch",
      originProvider: "todo-workflow",
      originId: "todo-1",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(host.stdin.read()?.toString()).toContain('"type":"html"');
  expect(request).toHaveBeenLastCalledWith("/tmp/kanban.sock", {
    id: "launch-todo-workflow-todo-1",
    method: "features.launch",
    params: {
      originProvider: "todo-workflow",
      originId: "todo-1",
    },
  });
});

test("default Glimpse opener sends initial HTML only for the first ready event", async () => {
  await writeBuiltSvelteShell();
  const host = createMockHostProcess();
  spawnMock.mockReturnValue(host);

  await openGlimpseKanban("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({ result: [] }),
  });

  writeHostMessage(host, { type: "ready" });
  writeHostMessage(host, { type: "ready" });
  await new Promise((resolve) => setImmediate(resolve));

  const writes = host.stdin.read()?.toString() ?? "";
  expect(writes.match(/"type":"html"/g)).toHaveLength(1);
});

test("openGlimpseKanban forwards launch origin to daemon", async () => {
  const request = vi.fn().mockResolvedValue({ result: [] });
  const sendMessage = await openKanbanWithCapturedMessageHandler({ request });

  await sendMessage({
    type: "launch",
    originProvider: "todo-workflow",
    originId: "todo-1",
  });

  expect(request).toHaveBeenLastCalledWith("/tmp/kanban.sock", {
    id: "launch-todo-workflow-todo-1",
    method: "features.launch",
    params: {
      originProvider: "todo-workflow",
      originId: "todo-1",
    },
  });
});

test("openGlimpseKanban reports rejected launch requests back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockRejectedValueOnce(new Error("launch failed"));
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await expect(
    sendMessage({
      type: "launch",
      originProvider: "todo-workflow",
      originId: "todo-1",
    }),
  ).resolves.toBeUndefined();

  expect(send).toHaveBeenCalledWith(
    expect.stringContaining("kanban:launch-result"),
  );
  expect(send).toHaveBeenCalledWith(expect.stringContaining('"ok":false'));
  expect(send).toHaveBeenCalledWith(
    expect.stringContaining('"originId":"todo-1"'),
  );
  expect(send).toHaveBeenCalledWith(expect.stringContaining("launch failed"));
});

test("openGlimpseKanban reports launched run back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({ result: launchedRun() });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "launch",
    originProvider: "todo-workflow",
    originId: "todo-1",
  });

  expectPageEvent(send, "kanban:launch-result", [
    '"ok":true',
    '"originId":"todo-1"',
    '"branch":"main/todo-1"',
  ]);
});

test("openGlimpseKanban reports daemon launch errors back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({ error: { message: "launch failed" } });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "launch",
    originProvider: "todo-workflow",
    originId: "todo-1",
  });

  expectPageEvent(send, "kanban:launch-result", [
    '"ok":false',
    '"originId":"todo-1"',
    "launch failed",
  ]);
});

test("openGlimpseKanban forwards create title and branch names to daemon", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: createdIssue({ workBranch: "feature/ui" }),
    });
  const sendMessage = await openKanbanWithCapturedMessageHandler({ request });

  await sendMessage({
    type: "create",
    title: "Created from UI",
    baseBranch: "feature/base",
    workBranch: "feature/ui",
  });

  expect(request).toHaveBeenLastCalledWith("/tmp/kanban.sock", {
    id: "create-Created from UI",
    method: "requirements.create",
    params: {
      title: "Created from UI",
      baseBranch: "feature/base",
      workBranch: "feature/ui",
    },
  });
});

test("openGlimpseKanban asks for work branch before creating", async () => {
  const send = vi.fn();
  const request = vi.fn().mockResolvedValueOnce({ result: [] });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created from UI",
    clientRequestId: "client-1",
  });

  expect(request).toHaveBeenCalledTimes(1);
  expectPageEvent(send, "kanban:create-result", [
    '"ok":false',
    '"clientRequestId":"client-1"',
    "Enter a work branch name.",
  ]);
});

test("openGlimpseKanban forwards branch list requests to daemon", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: { branches: ["main", "feature/base"], defaultBranch: "main" },
    });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({ type: "branches:list" });

  expect(request).toHaveBeenLastCalledWith("/tmp/kanban.sock", {
    id: "branches-list",
    method: "branches.list",
  });
  expectPageEvent(send, "kanban:branches-result", [
    '"ok":true',
    '"branches":["main","feature/base"]',
    '"defaultBranch":"main"',
  ]);
});

test("openGlimpseKanban reports branch list failures back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockRejectedValueOnce(new Error("git failed"));
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({ type: "branches:list" });

  expectPageEvent(send, "kanban:branches-result", ['"ok":false', "git failed"]);
});

test("openGlimpseKanban reports created issue back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({ result: createdIssue() });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created from UI",
    workBranch: "feature/ui",
    clientRequestId: "client-1",
  });

  expectPageEvent(send, "kanban:create-result", [
    '"ok":true',
    '"clientRequestId":"client-1"',
    '"originId":"new-todo"',
  ]);
});

test("openGlimpseKanban normalizes legacy create results", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: {
        id: "legacy-todo",
        description: "Created from old daemon",
        status: "todo",
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:00.000Z",
      },
    });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created from old daemon",
    workBranch: "feature/legacy-todo",
    clientRequestId: "client-1",
  });

  expectPageEvent(send, "kanban:create-result", [
    '"ok":true',
    '"issueId":"todo-workflow:legacy-todo"',
    '"originId":"legacy-todo"',
    '"status":"in-box"',
  ]);
});

test("openGlimpseKanban reports diagnostic malformed create results", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({ result: { unexpected: true } });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created from UI",
    workBranch: "feature/ui",
    clientRequestId: "client-1",
  });

  expectPageEvent(send, "kanban:create-result", [
    '"ok":false',
    "requirements.create returned an unrecognized issue",
    "unexpected",
  ]);
});

test("openGlimpseKanban reports create failures back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockRejectedValueOnce(new Error("socket failed"));
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created from UI",
    workBranch: "feature/ui",
    clientRequestId: "client-1",
  });

  expectPageEvent(send, "kanban:create-result", [
    '"ok":false',
    '"clientRequestId":"client-1"',
    "socket failed",
  ]);
});

test("openGlimpseKanban launches created issue when requested", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: createdIssue({ title: "Created and launched" }),
    })
    .mockResolvedValueOnce({
      result: launchedRun({ originId: "new-todo" }),
    });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created and launched",
    workBranch: "feature/new-todo",
    launch: true,
  });

  expect(request).toHaveBeenLastCalledWith("/tmp/kanban.sock", {
    id: "launch-todo-workflow-new-todo",
    method: "features.launch",
    params: {
      originProvider: "todo-workflow",
      originId: "new-todo",
    },
  });
  expectPageEvent(send, "kanban:launch-result");
});

test("openGlimpseKanban keeps create success when launch-after-create fails", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: createdIssue({ title: "Created and launched" }),
    })
    .mockRejectedValueOnce(new Error("launch failed"));
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "create",
    title: "Created and launched",
    workBranch: "feature/new-todo",
    launch: true,
    clientRequestId: "client-1",
  });

  const createResultCalls = send.mock.calls.filter(([js]) =>
    String(js).includes("kanban:create-result"),
  );
  expect(createResultCalls).toHaveLength(1);
  expect(createResultCalls[0]?.[0]).toEqual(
    expect.stringContaining('"ok":true'),
  );
  expectPageEvent(send, "kanban:launch-result", [
    '"ok":false',
    '"originId":"new-todo"',
    "launch failed",
  ]);
});

test("openGlimpseKanban forwards delete intent to daemon", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: createdIssue({ originId: "todo-1", title: "Delete me" }),
    });
  const sendMessage = await openKanbanWithCapturedMessageHandler({ request });

  await sendMessage({
    type: "delete",
    originProvider: "todo-workflow",
    originId: "todo-1",
  });

  expect(request).toHaveBeenLastCalledWith("/tmp/kanban.sock", {
    id: "delete-todo-workflow-todo-1",
    method: "requirements.remove",
    params: {
      originProvider: "todo-workflow",
      originId: "todo-1",
    },
  });
});

test("openGlimpseKanban reports delete results back to the page", async () => {
  const send = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce({
      result: createdIssue({ originId: "todo-1", title: "Delete me" }),
    });
  const sendMessage = await openKanbanWithCapturedMessageHandler({
    request,
    send,
  });

  await sendMessage({
    type: "delete",
    originProvider: "todo-workflow",
    originId: "todo-1",
  });

  expectPageEvent(send, "kanban:delete-result", [
    '"ok":true',
    '"originId":"todo-1"',
  ]);
});

test("Svelte UI reconciles create and launch acknowledgements from Glimpse host", async () => {
  const app = await readFile(
    new URL("./ui/src/App.svelte", import.meta.url),
    "utf8",
  );

  expect(app).toContain("clientRequestId");
  expect(app).toContain("pendingCreateId");
  expect(app).toContain('addEventListener("kanban:create-result"');
  expect(app).toContain('addEventListener("kanban:launch-result"');
  expect(app).toContain('addEventListener("kanban:branches-result"');
  expect(app).toContain("handleCreateResult");
  expect(app).toContain("handleLaunchResult");
  expect(app).toContain("handleBranchesResult");
  expect(app).toContain("launchingIssueKeys");
  expect(app).toContain("newWorkBranch");
  expect(app).toContain("Enter a work branch name.");
  expect(app).toContain("Work branch");
  expect(app).toContain("<select bind:value={newBaseBranch}");
  expect(app).toContain('addEventListener("kanban:delete-result"');
  expect(app).toContain("confirmingDeleteKey");
  expect(app).toContain("Delete TODO?");
  expect(app).toContain('type: "delete"');
});

test("Svelte entrypoint uses Svelte 5 mount API", async () => {
  const entrypoint = await readFile(
    new URL("./ui/src/main.ts", import.meta.url),
    "utf8",
  );

  expect(entrypoint).toContain('import { mount } from "svelte"');
  expect(entrypoint).toContain("mount(App, { target })");
  expect(entrypoint).not.toContain("new App({ target })");
});

test("inlines built Svelte assets so Glimpse can render string HTML", async () => {
  await mkdir(path.join(dir, "assets"));
  await writeFile(
    path.join(dir, "index.html"),
    [
      "<!doctype html><html><head>",
      '<script type="module" crossorigin src="/assets/app.js"></script>',
      '<link rel="stylesheet" href="/assets/app.css">',
      '</head><body><div id="app"></div></body></html>',
    ].join(""),
  );
  await writeFile(
    path.join(dir, "assets", "app.js"),
    "window.__APP_RAN__ = true;",
  );
  await writeFile(path.join(dir, "assets", "app.css"), "body { color: red; }");

  const html = await createGlimpseHtml("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({ result: [] }),
  });

  expect(html).toContain("window.__APP_RAN__ = true;");
  expect(html).toContain("body { color: red; }");
  expect(html).not.toContain('src="/assets/app.js"');
  expect(html).not.toContain('href="/assets/app.css"');
});

test("injects boot data into the built Svelte HTML shell", async () => {
  await writeBuiltSvelteShell();

  const html = await createGlimpseHtml("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({
      result: [
        {
          issueId: "todo-workflow:issue-1",
          originProvider: "todo-workflow",
          originId: "issue-1",
          title: "Launch me",
          description: "Launch me",
          status: "in-box",
          repoRoot: "/repo",
          baseBranch: "main",
          slug: "issue-1",
          createdAt: "2026-05-09T00:00:00.000Z",
          updatedAt: "2026-05-09T00:00:00.000Z",
        },
      ],
    }),
  });

  expect(html).toContain("window.__KANBAN_BOOT__");
  expect(html).toContain('"socketPath":"/tmp/kanban.sock"');
  expect(html).toContain('"issueId":"todo-workflow:issue-1"');
  expect(html).toContain('"originId":"issue-1"');
  expect(html).toContain('"baseBranch":"main"');
  expect(html).toContain('"updatedAt":"2026-05-09T00:00:00.000Z"');
  expect(html).toContain('script type="module"');
});
