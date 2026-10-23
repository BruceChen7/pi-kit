import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import receipts from "./index.js";
import { readReceipts, receiptsPath } from "./store.js";

const tempDirs: string[] = [];
const originalGate = process.env.PI_RECEIPT_GATE;

type Handler = (event: unknown, ctx: { cwd: string }) => Promise<unknown>;

const build = () => {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  receipts(pi as unknown as ExtensionAPI);
  const emit = async (name: string, event: unknown, cwd: string) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      result = await handler(event, { cwd });
    }
    return result;
  };
  return { emit };
};

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-receipts-"));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
};

const testResult = (command: string, output: string, exitCode = 0) => ({
  toolName: "bash",
  input: { command },
  content: [{ type: "text", text: output }],
  structuredContent: { output, exit_code: exitCode },
  isError: exitCode !== 0,
});

const commitCall = (message: string) => ({
  toolName: "bash",
  input: { command: `git commit -m "${message}"` },
});

beforeEach(() => {
  tempDirs.length = 0;
  delete process.env.PI_RECEIPT_GATE;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalGate === undefined) {
    delete process.env.PI_RECEIPT_GATE;
  } else {
    process.env.PI_RECEIPT_GATE = originalGate;
  }
});

describe("recording receipts", () => {
  it("records a passing test run in the git directory", async () => {
    const repo = makeRepo();
    const { emit } = build();

    await emit(
      "tool_result",
      testResult("npx vitest run", " Tests  12 passed (12)\n"),
      repo,
    );

    const file = receiptsPath(repo);
    expect(file).not.toBeNull();
    const receiptsList = readReceipts(file as string);
    expect(receiptsList).toHaveLength(1);
    expect(receiptsList[0]).toMatchObject({
      command: "npx vitest run",
      passed: 12,
      failed: 0,
      exitCode: 0,
    });
    // 收据不进工作区。
    expect(fs.readdirSync(repo).some((name) => name.includes("receipt"))).toBe(
      false,
    );
  });

  it("keeps the latest run per command", async () => {
    const repo = makeRepo();
    const { emit } = build();
    await emit("tool_result", testResult("npm test", "10 passed"), repo);
    await emit("tool_result", testResult("npm test", "11 passed"), repo);

    const list = readReceipts(receiptsPath(repo) as string);
    expect(list).toHaveLength(1);
    expect(list[0]?.passed).toBe(11);
  });

  it("ignores commands that are not test runs, and runs with no counts", async () => {
    const repo = makeRepo();
    const { emit } = build();
    await emit("tool_result", testResult("ls -la", "12 passed"), repo);
    await emit("tool_result", testResult("go test ./...", "ok pkg 0.1s"), repo);

    expect(readReceipts(receiptsPath(repo) as string)).toEqual([]);
  });
});

describe("the publish gate", () => {
  it("allows a commit whose count matches a recorded run", async () => {
    const repo = makeRepo();
    const { emit } = build();
    await emit(
      "tool_result",
      testResult("npx vitest run", "Tests  12 passed (12)"),
      repo,
    );

    expect(
      await emit("tool_call", commitCall("feat: x\n\nTests: 12"), repo),
    ).toEqual({});
  });

  it("blocks a commit whose count matches nothing", async () => {
    const repo = makeRepo();
    const { emit } = build();
    await emit(
      "tool_result",
      testResult("npx vitest run", "Tests  12 passed (12)"),
      repo,
    );

    const result = (await emit(
      "tool_call",
      commitCall("feat: x\n\nTests: 999"),
      repo,
    )) as { block?: boolean; reason?: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("12 passed");
  });

  it("blocks a claim when nothing was recorded at all", async () => {
    const repo = makeRepo();
    const { emit } = build();
    const result = (await emit("tool_call", commitCall("Tests: 12"), repo)) as {
      block?: boolean;
    };
    expect(result.block).toBe(true);
  });

  it("stays out of the way when the message makes no claim", async () => {
    const repo = makeRepo();
    const { emit } = build();
    expect(
      await emit("tool_call", commitCall("refactor: rename helper"), repo),
    ).toEqual({});
  });

  it("only looks at commit and PR creation", async () => {
    const repo = makeRepo();
    const { emit } = build();
    expect(await emit("tool_call", commitCall("x"), repo)).toEqual({});
    expect(
      await emit(
        "tool_call",
        { toolName: "bash", input: { command: 'echo "Tests: 999"' } },
        repo,
      ),
    ).toEqual({});
  });

  it("honours the escape hatch", async () => {
    const repo = makeRepo();
    const { emit } = build();
    process.env.PI_RECEIPT_GATE = "off";
    expect(await emit("tool_call", commitCall("Tests: 999"), repo)).toEqual({});
  });
});
