import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CacheSessionMetrics, DashboardInitialView } from "./types.ts";

export type CacheGraphBootData = {
  initialView: DashboardInitialView;
  metrics: CacheSessionMetrics;
};

export type CreateCacheGraphHtmlOptions = {
  uiDistDir?: string;
};

const DEFAULT_UI_DIST_DIR = fileURLToPath(
  new URL("./ui-dist", import.meta.url),
);

export async function createCacheGraphHtml(
  bootData: CacheGraphBootData,
  options: CreateCacheGraphHtmlOptions = {},
): Promise<string> {
  const uiDistDir = options.uiDistDir ?? DEFAULT_UI_DIST_DIR;
  const html = await inlineBuiltAssets(await readUiHtml(uiDistDir), uiDistDir);
  return injectBootData(html, bootData);
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

function injectBootData(html: string, bootData: CacheGraphBootData): string {
  const bootScript = `<script>window.__CACHE_GRAPH_BOOT__=${escapeScriptJson(bootData)};</script>`;
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${bootScript}${html.slice(insertAt)}`;
  }
  return `${bootScript}${html}`;
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
