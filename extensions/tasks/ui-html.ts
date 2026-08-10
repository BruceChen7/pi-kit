/**
 * Tasks Glimpse UI — build the interactive HTML from the built Svelte app
 * (ui-dist), inlining all assets and injecting boot data, then open a
 * Glimpse window with the bridge attached.
 *
 * Mirrors visual-artifact's ui-html.ts: read ui-dist/index.html, inline
 * script/style assets (the Glimpse host loads a single HTML), inject boot
 * data into window.__TASKS_BOOT__.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openGlimpseWindow } from "../shared/glimpse-window.ts";
import { defaultDbPath } from "./db.ts";
import {
  registerWindow,
  startDbWatcher,
  type TasksBridgeContext,
} from "./ui-bridge.ts";

const DEFAULT_UI_DIST_DIR = fileURLToPath(
  new URL("./ui-dist", import.meta.url),
);

export type TasksBootData = {
  projectRoot: string;
};

export type CreateTasksHtmlOptions = {
  bootData: TasksBootData;
  uiDistDir?: string;
};

export async function createTasksHtml(
  options: CreateTasksHtmlOptions,
): Promise<string> {
  const uiDistDir = options.uiDistDir ?? DEFAULT_UI_DIST_DIR;
  const rawHtml = await readFile(path.join(uiDistDir, "index.html"), "utf8");
  const built = await inlineBuiltAssets(rawHtml, uiDistDir);
  return injectBootData(built, options.bootData);
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
      const content = await readFile(path.join(uiDistDir, src), "utf8");
      return `<script${before}${after}>${escapeInlineScript(content)}</script>`;
    },
  );
}

async function inlineStyleAssets(
  html: string,
  uiDistDir: string,
): Promise<string> {
  return replaceAsync(
    html,
    /<link\b([^>]*)\brel="stylesheet"([^>]*)href="([^"]+)"([^>]*)\/?>/g,
    async (
      _match,
      before: string,
      mid: string,
      href: string,
      _after: string,
    ) => {
      const content = await readFile(path.join(uiDistDir, href), "utf8");
      return `<style${before}${mid}>${content}</style>`;
    },
  );
}

/** Escape closing script tags inside inline JS (raw-text safety). */
function escapeInlineScript(content: string): string {
  return content.replace(/<\/script/gi, "<\\/script");
}

function injectBootData(html: string, bootData: TasksBootData): string {
  const script = `<script>window.__TASKS_BOOT__ = ${JSON.stringify(bootData).replace(/</g, "\\u003c")};</script>`;
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + script + html.slice(headClose);
  }
  return script + html;
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(regex)];
  const replacements = await Promise.all(
    matches.map((match) => replacer(...Array.from(match))),
  );
  return matches.reduceRight((output, match, index) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return `${output.slice(0, start)}${replacements[index]}${output.slice(end)}`;
  }, input);
}

/* ------------------------------------------------------------------ */
/*  Window opening + bridge attachment                                 */
/* ------------------------------------------------------------------ */

let windowCounter = 0;

export async function openTasksBoard(
  pi: ExtensionAPI,
  projectRoot: string,
): Promise<void> {
  const html = await createTasksHtml({
    bootData: { projectRoot },
  });

  const win = openGlimpseWindow(html, {
    width: 1200,
    height: 760,
    title: "Tasks",
  });

  const windowId = `tasks-${++windowCounter}`;
  const ctx: TasksBridgeContext = {
    pi,
    projectRoot,
    dbPath: defaultDbPath(projectRoot),
  };

  registerWindow(windowId, win, ctx);
  startDbWatcher(ctx);

  // The window requests the initial snapshot itself via { type: "get-snapshot" }.
}
