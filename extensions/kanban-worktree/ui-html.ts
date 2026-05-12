import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readIssuesResult, requirementsListRequest } from "./kanban-rpc.ts";
import { sendJsonLineRequest } from "./protocol.ts";

type RequestFn = (socketPath: string, message: unknown) => Promise<unknown>;

export type CreateKanbanHtmlOptions = {
  request?: RequestFn;
  uiDistDir?: string;
};

const DEFAULT_UI_DIST_DIR = fileURLToPath(
  new URL("./ui-dist", import.meta.url),
);

export async function createKanbanHtml(
  socketPath: string,
  options: CreateKanbanHtmlOptions = {},
): Promise<string> {
  const request = options.request ?? sendJsonLineRequest;
  const response = await request(socketPath, requirementsListRequest());
  const uiDistDir = options.uiDistDir ?? DEFAULT_UI_DIST_DIR;
  return injectBootData(
    await inlineBuiltAssets(await readUiHtml(uiDistDir), uiDistDir),
    {
      socketPath,
      issues: readIssuesResult(response),
    },
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
