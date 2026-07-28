/**
 * UI HTML asset inlining and boot data injection.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type VisualArtifactBootData = {
  view: "home" | "project" | "artifact";
  projectName?: string;
  artifactSlug?: string;
  artifactSpec?: unknown;
  projects?: { name: string; artifactCount: number }[];
  artifacts?: { slug: string; title: string; description?: string }[];
};

export type CreateVisualArtifactHtmlOptions = {
  bootData: VisualArtifactBootData;
  uiDistDir?: string;
};

const DEFAULT_UI_DIST_DIR = fileURLToPath(
  new URL("./ui-dist", import.meta.url),
);

export async function createVisualArtifactHtml(
  options: CreateVisualArtifactHtmlOptions,
): Promise<string> {
  const uiDistDir = options.uiDistDir ?? DEFAULT_UI_DIST_DIR;
  const rawHtml = await readUiHtml(uiDistDir);
  const bootData = options.bootData;

  console.log(
    `[visual-artifact] ui-dist: ${uiDistDir}, raw HTML: ${rawHtml.length} bytes`,
  );

  const built = await inlineBuiltAssets(rawHtml, uiDistDir);
  const result = injectBootData(built, bootData);

  const bootJsonSize = JSON.stringify(bootData).length;
  console.log(
    `[visual-artifact] Final HTML: ${result.length} bytes, ` +
      `boot data: ${bootJsonSize} bytes, ` +
      `view: ${bootData.view}`,
  );

  return result;
}

async function readUiHtml(uiDistDir: string): Promise<string> {
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
      const content = escapeInlineScriptContent(
        await readAsset(uiDistDir, src),
      );
      if (!content) {
        console.warn(
          `[visual-artifact] Script asset is empty or missing: ${src}`,
        );
      }
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
      if (!content) {
        console.warn(
          `[visual-artifact] Style asset is empty or missing: ${href}`,
        );
      }
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

function injectBootData(
  html: string,
  bootData: VisualArtifactBootData,
): string {
  const bootScript = `<script>window.__VISUAL_ARTIFACT_BOOT__=${escapeScriptJson(bootData)};</script>`;
  const headCloseIndex = html.lastIndexOf("</head>");
  if (headCloseIndex >= 0) {
    return `${html.slice(0, headCloseIndex)}${bootScript}</head>${html.slice(headCloseIndex + 7)}`;
  }
  return `${bootScript}${html}`;
}

function escapeInlineScriptContent(content: string): string {
  return content
    .replace(/<\/script/giu, "<\\/script")
    .replace(/<\/head/giu, "<\\/head")
    .replace(/<\/body/giu, "<\\/body");
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
