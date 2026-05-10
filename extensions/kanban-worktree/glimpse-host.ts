import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { getNativeHostInfo } from "glimpseui";

import { sendJsonLineRequest } from "./protocol.ts";

type JsonRecord = Record<string, unknown>;

type RequestFn = (socketPath: string, message: unknown) => Promise<unknown>;

type CreateGlimpseHtmlOptions = {
  request?: RequestFn;
  uiDistDir?: string;
};

type StderrWriteCallback = (error?: Error | null) => void;

type StderrWriteArgs = [
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | StderrWriteCallback,
  callback?: StderrWriteCallback,
];

type OpenWindowFn = (
  html: string,
  options: typeof GLIMPSE_WINDOW_OPTIONS,
) => GlimpseWindow;

type OpenGlimpseKanbanOptions = CreateGlimpseHtmlOptions & {
  openWindow?: OpenWindowFn;
  glimpseStderrLogPath?: string;
};

type IssueSummary = {
  issueId: string;
  originProvider: string;
  originId: string;
  title: string;
  description?: string;
  status: string;
  repoRoot?: string;
  baseBranch?: string;
  slug?: string;
  workBranch?: string;
  worktreePath?: string;
  createdAt?: string;
  updatedAt?: string;
};

type GlimpseWindow = {
  on(
    event: "message",
    handler: (message: unknown) => void | Promise<void>,
  ): void;
  send?(js: string): void;
  close?(): void;
};

type NativeHostInfo = {
  path: string;
  extraArgs?: string[];
};

type LaunchIntent = {
  originProvider: string;
  originId: string;
};

type LaunchIntentHandlerInput = {
  socketPath: string;
  request: RequestFn;
  window: GlimpseWindow;
  launch: LaunchIntent;
};

type CreateIntent = {
  title: string;
  baseBranch: string | null;
  workBranch: string | null;
  launch: boolean;
  clientRequestId: string | null;
};

type CreateIntentHandlerInput = {
  socketPath: string;
  request: RequestFn;
  window: GlimpseWindow;
  create: CreateIntent;
};

type DeleteIntent = {
  originProvider: string;
  originId: string;
};

type DeleteIntentHandlerInput = {
  socketPath: string;
  request: RequestFn;
  window: GlimpseWindow;
  deletion: DeleteIntent;
};

type CreateResult =
  | {
      type: "create-result";
      ok: true;
      clientRequestId: string | null;
      issue: IssueSummary;
    }
  | {
      type: "create-result";
      ok: false;
      clientRequestId: string | null;
      error: string;
    };

type LaunchResult =
  | {
      type: "launch-result";
      ok: true;
      originProvider: string;
      originId: string;
      run: unknown;
    }
  | {
      type: "launch-result";
      ok: false;
      originProvider: string;
      originId: string;
      error: string;
    };

type BranchesResult =
  | {
      type: "branches-result";
      ok: true;
      branches: string[];
      defaultBranch: string;
    }
  | {
      type: "branches-result";
      ok: false;
      error: string;
    };

type DeleteResult =
  | {
      type: "delete-result";
      ok: true;
      originProvider: string;
      originId: string;
      issue: IssueSummary | null;
    }
  | {
      type: "delete-result";
      ok: false;
      originProvider: string;
      originId: string;
      error: string;
    };

type InteractionResult =
  | CreateResult
  | LaunchResult
  | BranchesResult
  | DeleteResult;

const INITIAL_LIST_REQUEST = {
  id: "initial-list",
  method: "requirements.list",
};
const GLIMPSE_WINDOW_OPTIONS = {
  width: 1100,
  height: 720,
  title: "Kanban Worktree",
};
const DEFAULT_UI_DIST_DIR = fileURLToPath(
  new URL("./ui-dist", import.meta.url),
);

function defaultGlimpseStderrLogPath(): string {
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "kanban-worktree",
    "glimpse-stderr.log",
  );
}

export async function createGlimpseHtml(
  socketPath: string,
  options: CreateGlimpseHtmlOptions = {},
): Promise<string> {
  const request = options.request ?? sendJsonLineRequest;
  const response = await request(socketPath, INITIAL_LIST_REQUEST);
  const uiDistDir = options.uiDistDir ?? DEFAULT_UI_DIST_DIR;
  return injectBootData(
    await inlineBuiltAssets(await readUiHtml(uiDistDir), uiDistDir),
    {
      socketPath,
      issues: readIssues(response),
    },
  );
}

export async function openGlimpseKanban(
  socketPath: string,
  options: OpenGlimpseKanbanOptions = {},
): Promise<void> {
  const request = options.request ?? sendJsonLineRequest;
  const openWindow = options.openWindow ?? openGlimpseWindow;
  const html = await createGlimpseHtml(socketPath, {
    request,
    uiDistDir: options.uiDistDir,
  });
  const glimpseStderrLogPath =
    options.glimpseStderrLogPath ?? defaultGlimpseStderrLogPath();
  const window = withRedirectedOpenWindowStderr(glimpseStderrLogPath, () =>
    openWindow(html, GLIMPSE_WINDOW_OPTIONS),
  );
  window.on("message", async (message: unknown) => {
    const launch = readLaunchIntent(message);
    if (launch) {
      await handleLaunchIntent({ socketPath, request, window, launch });
      return;
    }
    if (readBranchesIntent(message)) {
      await handleBranchesIntent({ socketPath, request, window });
      return;
    }
    const create = readCreateIntent(message);
    if (create) {
      await handleCreateIntent({ socketPath, request, window, create });
      return;
    }
    const deletion = readDeleteIntent(message);
    if (deletion) {
      await handleDeleteIntent({ socketPath, request, window, deletion });
    }
  });
}

function openGlimpseWindow(
  html: string,
  options: typeof GLIMPSE_WINDOW_OPTIONS,
): GlimpseWindow {
  const host = getNativeHostInfo() as NativeHostInfo;
  const args = [...(host.extraArgs ?? []), ...glimpseWindowArgs(options)];
  const proc = spawn(host.path, args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: process.platform === "win32",
  });
  return new PiKitGlimpseWindow(proc, html);
}

function glimpseWindowArgs(options: typeof GLIMPSE_WINDOW_OPTIONS): string[] {
  return [
    "--width",
    String(options.width),
    "--height",
    String(options.height),
    "--title",
    options.title,
  ];
}

class PiKitGlimpseWindow extends EventEmitter implements GlimpseWindow {
  #pendingHtmlBase64: string | null;
  #closed = false;

  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    initialHtml: string,
  ) {
    super();
    this.#pendingHtmlBase64 = Buffer.from(initialHtml).toString("base64");
    proc.stdin.on("error", () => {});
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.#handleLine(line));
    proc.on("error", (error) => this.emit("error", error));
    proc.on("exit", () => this.#markClosed());
  }

  send(js: string): void {
    this.#write({ type: "eval", js });
  }

  close(): void {
    this.#write({ type: "close" });
  }

  #handleLine(line: string): void {
    const message = parseHostMessage(line);
    if (!message) return;

    switch (message.type) {
      case "ready":
        this.#sendPendingHtml();
        return;
      case "message":
        this.emit("message", message.data);
        return;
      case "closed":
        this.#markClosed();
    }
  }

  #sendPendingHtml(): void {
    if (!this.#pendingHtmlBase64) return;
    this.#write({ type: "html", html: this.#pendingHtmlBase64 });
    this.#pendingHtmlBase64 = null;
  }

  #write(message: JsonRecord): void {
    if (this.#closed) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("closed");
  }
}

function parseHostMessage(line: string): JsonRecord | null {
  try {
    const message = JSON.parse(line);
    return isRecord(message) ? message : null;
  } catch {
    return null;
  }
}

function appendGlimpseStderr(logPath: string, args: StderrWriteArgs): void {
  const [chunk, encodingOrCallback] = args;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    if (typeof chunk === "string") {
      const encoding =
        typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
      appendFileSync(logPath, chunk, { encoding });
      return;
    }
    appendFileSync(logPath, chunk);
  } catch {
    // Do not block opening Glimpse if diagnostic logging fails.
  }
}

function withRedirectedOpenWindowStderr<T>(logPath: string, run: () => T): T {
  const originalWrite = process.stderr.write;
  process.stderr.write = ((...args: StderrWriteArgs) => {
    appendGlimpseStderr(logPath, args);
    readStderrWriteCallback(args)?.();
    return true;
  }) as typeof process.stderr.write;

  try {
    return run();
  } finally {
    process.stderr.write = originalWrite;
  }
}

function readStderrWriteCallback(
  args: StderrWriteArgs,
): StderrWriteCallback | undefined {
  const callback = args[2] ?? args[1];
  return typeof callback === "function" ? callback : undefined;
}

async function handleCreateIntent(
  input: CreateIntentHandlerInput,
): Promise<void> {
  const { socketPath, request, window, create } = input;
  try {
    if (!create.workBranch) {
      sendInteractionResult(
        window,
        createFailureResult(
          create.clientRequestId,
          "Enter a work branch name.",
        ),
      );
      return;
    }

    const response = await request(socketPath, createRequest(create));
    const result = createResultFromResponse(create.clientRequestId, response);
    sendInteractionResult(window, result);
    if (result.ok && create.launch) {
      await handleLaunchIntent({
        socketPath,
        request,
        window,
        launch: result.issue,
      });
    }
  } catch (error) {
    sendInteractionResult(
      window,
      createFailureResult(create.clientRequestId, errorMessage(error)),
    );
  }
}

async function handleLaunchIntent(
  input: LaunchIntentHandlerInput,
): Promise<void> {
  const { socketPath, request, window, launch } = input;
  try {
    const response = await request(socketPath, launchRequest(launch));
    sendInteractionResult(window, launchResultFromResponse(launch, response));
  } catch (error) {
    sendInteractionResult(
      window,
      launchFailureResult(launch, errorMessage(error)),
    );
  }
}

async function handleDeleteIntent(
  input: DeleteIntentHandlerInput,
): Promise<void> {
  const { socketPath, request, window, deletion } = input;
  try {
    const response = await request(socketPath, deleteRequest(deletion));
    sendInteractionResult(window, deleteResultFromResponse(deletion, response));
  } catch (error) {
    sendInteractionResult(
      window,
      deleteFailureResult(deletion, errorMessage(error)),
    );
  }
}

async function handleBranchesIntent(input: {
  socketPath: string;
  request: RequestFn;
  window: GlimpseWindow;
}): Promise<void> {
  const { socketPath, request, window } = input;
  try {
    const response = await request(socketPath, branchesRequest());
    sendInteractionResult(window, branchesResultFromResponse(response));
  } catch (error) {
    sendInteractionResult(window, branchesFailureResult(errorMessage(error)));
  }
}

function createResultFromResponse(
  clientRequestId: string | null,
  response: unknown,
): CreateResult {
  const error = readResponseError(response);
  if (error) return createFailureResult(clientRequestId, error);

  const issue = readCreatedIssue(response);
  if (!issue) {
    return createFailureResult(
      clientRequestId,
      unrecognizedIssueMessage(response),
    );
  }

  return createSuccessResult(clientRequestId, issue);
}

function createSuccessResult(
  clientRequestId: string | null,
  issue: IssueSummary,
): CreateResult {
  return {
    type: "create-result",
    ok: true,
    clientRequestId,
    issue,
  };
}

function createFailureResult(
  clientRequestId: string | null,
  error: string,
): CreateResult {
  return {
    type: "create-result",
    ok: false,
    clientRequestId,
    error,
  };
}

function launchResultFromResponse(
  launch: LaunchIntent,
  response: unknown,
): LaunchResult {
  const error = readResponseError(response);
  if (error) return launchFailureResult(launch, error);
  const run = isRecord(response) ? response.result : null;
  return launchSuccessResult(launch, run);
}

function launchSuccessResult(launch: LaunchIntent, run: unknown): LaunchResult {
  return {
    type: "launch-result",
    ok: true,
    originProvider: launch.originProvider,
    originId: launch.originId,
    run,
  };
}

function launchFailureResult(
  launch: LaunchIntent,
  error: string,
): LaunchResult {
  return {
    type: "launch-result",
    ok: false,
    originProvider: launch.originProvider,
    originId: launch.originId,
    error,
  };
}

function branchesResultFromResponse(response: unknown): BranchesResult {
  const error = readResponseError(response);
  if (error) return branchesFailureResult(error);

  const result = isRecord(response) ? response.result : null;
  if (!isRecord(result)) {
    return branchesFailureResult("branches.list returned an invalid result");
  }
  const branches = Array.isArray(result.branches)
    ? result.branches.filter(
        (branch): branch is string => typeof branch === "string",
      )
    : [];
  const defaultBranch = readOptionalString(result, "defaultBranch") ?? "main";
  return {
    type: "branches-result",
    ok: true,
    branches: branches.length > 0 ? branches : [defaultBranch],
    defaultBranch,
  };
}

function branchesFailureResult(error: string): BranchesResult {
  return {
    type: "branches-result",
    ok: false,
    error,
  };
}

function deleteResultFromResponse(
  deletion: DeleteIntent,
  response: unknown,
): DeleteResult {
  const error = readResponseError(response);
  if (error) return deleteFailureResult(deletion, error);
  return {
    type: "delete-result",
    ok: true,
    originProvider: deletion.originProvider,
    originId: deletion.originId,
    issue: readCreatedIssue(response),
  };
}

function deleteFailureResult(
  deletion: DeleteIntent,
  error: string,
): DeleteResult {
  return {
    type: "delete-result",
    ok: false,
    originProvider: deletion.originProvider,
    originId: deletion.originId,
    error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchRequest(launch: LaunchIntent): unknown {
  return {
    id: `launch-${launch.originProvider}-${launch.originId}`,
    method: "features.launch",
    params: {
      originProvider: launch.originProvider,
      originId: launch.originId,
    },
  };
}

function createRequest(create: CreateIntent): unknown {
  return {
    id: `create-${create.title}`,
    method: "requirements.create",
    params: {
      title: create.title,
      ...(create.baseBranch ? { baseBranch: create.baseBranch } : {}),
      workBranch: create.workBranch,
    },
  };
}

function branchesRequest(): unknown {
  return {
    id: "branches-list",
    method: "branches.list",
  };
}

function deleteRequest(deletion: DeleteIntent): unknown {
  return {
    id: `delete-${deletion.originProvider}-${deletion.originId}`,
    method: "requirements.remove",
    params: deletion,
  };
}

function sendInteractionResult(
  window: GlimpseWindow,
  result: InteractionResult,
): void {
  const detail = escapeScriptJson(result);
  window.send?.(
    `window.dispatchEvent(new CustomEvent("kanban:${result.type}", ` +
      `{ detail: ${detail} }));`,
  );
}

async function readUiHtml(uiDistDir = DEFAULT_UI_DIST_DIR): Promise<string> {
  return readFile(path.join(uiDistDir, "index.html"), "utf8");
}

async function inlineBuiltAssets(
  html: string,
  uiDistDir: string,
): Promise<string> {
  const withScripts = await inlineScriptAssets(html, uiDistDir);
  return inlineStyleAssets(withScripts, uiDistDir);
}

async function inlineScriptAssets(
  html: string,
  uiDistDir: string,
): Promise<string> {
  return replaceAsync(
    html,
    /<script\b([^>]*)\bsrc="([^"]+)"([^>]*)><\/script>/g,
    async (_match, before: string, src: string, after: string) => {
      const content = await readAsset(uiDistDir, src);
      return `<script${before}${after}>${content}</script>`;
    },
  );
}

async function inlineStyleAssets(
  html: string,
  uiDistDir: string,
): Promise<string> {
  return replaceAsync(
    html,
    /<link\b([^>]*)\bhref="([^"]+)"([^>]*)>/g,
    async (_match, before: string, href: string) => {
      const content = await readAsset(uiDistDir, href);
      return `<style${before}>${content}</style>`;
    },
  );
}

async function readAsset(
  uiDistDir: string,
  assetPath: string,
): Promise<string> {
  const relativePath = assetPath.replace(/^\//, "");
  try {
    return await readFile(path.join(uiDistDir, relativePath), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  const replacements = await Promise.all(
    matches.map((match) => replacer(...Array.from(match))),
  );
  return matches.reduceRight((output, match, index) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return `${output.slice(0, start)}${replacements[index]}${output.slice(end)}`;
  }, input);
}

function injectBootData(html: string, bootData: unknown): string {
  const bootScript = `<script>window.__KANBAN_BOOT__=${escapeScriptJson(bootData)};</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${bootScript}</head>`);
  }
  return `${bootScript}${html}`;
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function readIssues(response: unknown): IssueSummary[] {
  const result = isRecord(response) ? response.result : null;
  return Array.isArray(result) ? result.filter(isIssueSummary) : [];
}

function isIssueSummary(value: unknown): value is IssueSummary {
  return (
    isRecord(value) &&
    typeof value.issueId === "string" &&
    typeof value.originProvider === "string" &&
    typeof value.originId === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string"
  );
}

function readLaunchIntent(message: unknown): LaunchIntent | null {
  if (
    isRecord(message) &&
    message.type === "launch" &&
    typeof message.originProvider === "string" &&
    typeof message.originId === "string"
  ) {
    return {
      originProvider: message.originProvider,
      originId: message.originId,
    };
  }
  return null;
}

function readBranchesIntent(message: unknown): boolean {
  return isRecord(message) && message.type === "branches:list";
}

function readDeleteIntent(message: unknown): DeleteIntent | null {
  if (
    isRecord(message) &&
    message.type === "delete" &&
    typeof message.originProvider === "string" &&
    typeof message.originId === "string"
  ) {
    return {
      originProvider: message.originProvider,
      originId: message.originId,
    };
  }
  return null;
}

function readCreateIntent(message: unknown): CreateIntent | null {
  if (
    isRecord(message) &&
    message.type === "create" &&
    typeof message.title === "string" &&
    message.title.trim().length > 0
  ) {
    return {
      title: message.title.trim(),
      baseBranch: readOptionalString(message, "baseBranch") ?? null,
      workBranch: readOptionalString(message, "workBranch") ?? null,
      launch: message.launch === true,
      clientRequestId:
        typeof message.clientRequestId === "string"
          ? message.clientRequestId
          : null,
    };
  }
  return null;
}

function readResponseError(response: unknown): string | null {
  const error = isRecord(response) ? response.error : null;
  if (!isRecord(error) || typeof error.message !== "string") return null;
  return error.message;
}

function readCreatedIssue(response: unknown): IssueSummary | null {
  const result = isRecord(response) ? response.result : null;
  if (isIssueSummary(result)) return result;
  return normalizeLegacyIssue(result);
}

function normalizeLegacyIssue(value: unknown): IssueSummary | null {
  if (!isRecord(value)) return null;

  const originId = readFirstString(value, ["originId", "id"]);
  const title = readFirstString(value, ["title", "description"]);
  const status = readOptionalString(value, "status");
  if (!originId || !title || !status) return null;

  const description = readOptionalString(value, "description") ?? title;
  return {
    issueId:
      readOptionalString(value, "issueId") ?? `todo-workflow:${originId}`,
    originProvider:
      readOptionalString(value, "originProvider") ?? "todo-workflow",
    originId,
    title,
    description,
    status: status === "todo" ? "in-box" : status,
    repoRoot: readOptionalString(value, "repoRoot") ?? "",
    baseBranch: readOptionalString(value, "baseBranch") ?? "main",
    slug: readOptionalString(value, "slug") ?? originId,
    workBranch: readOptionalString(value, "workBranch"),
    worktreePath: readOptionalString(value, "worktreePath"),
    createdAt: readOptionalString(value, "createdAt") ?? "",
    updatedAt: readOptionalString(value, "updatedAt") ?? "",
  };
}

function readFirstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = readOptionalString(record, key);
    if (value) return value;
  }
  return null;
}

function readOptionalString(
  record: JsonRecord,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function unrecognizedIssueMessage(response: unknown): string {
  const result = isRecord(response) ? response.result : null;
  return `requirements.create returned an unrecognized issue result (${describeShape(result)})`;
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (!isRecord(value)) return typeof value;
  const keys = Object.keys(value).sort();
  return keys.length ? `keys: ${keys.join(", ")}` : "empty object";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
