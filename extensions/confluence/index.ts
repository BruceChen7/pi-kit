import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchConfluencePage } from "./browser";
import {
  type PageContext,
  renderConfluencePageMarkdown,
  resolvePageReference,
} from "./context";

const pageContext = Type.Object({
  url: Type.Optional(Type.String()),
  pageId: Type.Optional(Type.String()),
});

export interface ConfluencePageReader {
  read(
    url: string,
    pageId?: string,
    display?: import("./context").DisplayReference,
  ): Promise<PageContext>;
}

export interface ConfluenceExtensionOptions {
  readBaseUrl?: () => string | undefined;
  reader?: ConfluencePageReader;
}

export function buildConfluencePagePrompt(reference: string): string {
  const trimmed = reference.trim();
  const key = /^https?:\/\//.test(trimmed)
    ? `url: ${JSON.stringify(trimmed)}`
    : `pageId: ${JSON.stringify(trimmed)}`;
  return `Use confluence_page to fetch Confluence page with ${key}`;
}

function registerPageTool(
  pi: ExtensionAPI,
  baseUrl: string,
  reader: ConfluencePageReader,
): void {
  pi.registerTool({
    name: "confluence_page",
    label: "Confluence Page",
    description:
      "Read an internal SSO Confluence Server/Data Center page through the logged-in browser session and REST API.",
    promptSnippet:
      "confluence_page: read an internal SSO Confluence page and extract its content, headings, Jira keys, and Figma links.",
    parameters: pageContext,
    async execute(_id, params) {
      const input = params as { url?: string; pageId?: string };
      const reference = input.url?.trim() || input.pageId?.trim();
      const resolved = resolvePageReference(baseUrl, {
        url: reference,
        pageId: input.pageId,
      });
      const page = await reader.read(
        resolved.url,
        resolved.pageId,
        resolved.display,
      );
      return {
        content: [
          { type: "text" as const, text: renderConfluencePageMarkdown(page) },
        ],
        details: page,
      };
    },
  });
}

function registerCommands(pi: ExtensionAPI): void {
  if (typeof pi.registerCommand !== "function") return;
  const send =
    typeof pi.sendUserMessage === "function"
      ? pi.sendUserMessage.bind(pi)
      : undefined;
  const post = (message: string, ctx: { isIdle?: () => boolean }) => {
    if (!send) return;
    if (typeof ctx.isIdle === "function" && ctx.isIdle()) send(message);
    else send(message, { deliverAs: "followUp" });
  };
  pi.registerCommand("confluence-page", {
    description:
      "Fetch an internal Confluence page with context by URL or page ID",
    handler: async (args: string, ctx: { isIdle?: () => boolean }) => {
      const ref = args.trim();
      if (ref) post(buildConfluencePagePrompt(ref), ctx);
    },
  });
  pi.registerCommand("get-confluence-page", {
    description: "Get an internal Confluence page by ID",
    handler: async (args: string, ctx: { isIdle?: () => boolean }) => {
      const pageId = args.trim();
      if (pageId) post(buildConfluencePagePrompt(pageId), ctx);
    },
  });
}

export function createConfluenceExtension(
  options: ConfluenceExtensionOptions = {},
) {
  const readBaseUrl =
    options.readBaseUrl ?? (() => process.env.ATLASSIAN_CONFLUENCE_BASE_URL);
  const reader =
    options.reader ??
    ({ read: fetchConfluencePage } satisfies ConfluencePageReader);
  return (pi: ExtensionAPI): void => {
    const baseUrl = readBaseUrl()?.trim().replace(/\/+$/, "");
    if (!baseUrl) return;
    registerPageTool(pi, baseUrl, reader);
    registerCommands(pi);
  };
}

export default createConfluenceExtension();
