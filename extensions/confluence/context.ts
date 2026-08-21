export interface ExtractedLinks {
  urls: string[];
  figmaUrls: string[];
  jiraKeys: string[];
}

export interface PageContext {
  id: string;
  title: string;
  url: string;
  spaceId?: string;
  version?: number;
  updatedAt?: string;
  markdown: string;
  headings: string[];
  links: ExtractedLinks;
}

export interface ConfluencePageDto {
  id: string;
  title: string;
  storageHtml: string;
  spaceId?: string;
  version?: number;
  updatedAt?: string;
  url?: string;
}

export interface PageReference {
  pageId?: string;
  url: string;
}

export interface DisplayReference {
  spaceKey: string;
  title: string;
}

export function parseConfluencePageId(value?: string): string | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  for (const pattern of [
    /[?&]pageId=(\d+)/,
    /\/pages\/(\d+)/,
    /\/spaces\/[^/]+\/pages\/(\d+)/,
  ]) {
    const match = decoded.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function parseDisplayReference(value?: string): DisplayReference | null {
  if (!value) return null;
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/^\/display\/([^/]+)\/(.+)$/i);
  if (!match?.[1] || !match[2]) return null;
  const spaceKey = decodeURIComponent(match[1]);
  const title = decodeURIComponent(match[2])
    .replace(/\+/g, " ")
    .replace(/\/+$/, "");
  return { spaceKey, title };
}

export function resolvePageReference(
  baseUrl: string,
  input: { url?: string; pageId?: string },
): PageReference {
  const reference = input.url?.trim() || input.pageId?.trim();
  if (!reference) throw new Error("Pass a Confluence URL or pageId.");
  const configured = new URL(baseUrl);

  if (/^https?:\/\//.test(reference)) {
    const url = new URL(reference);
    if (url.origin !== configured.origin) {
      throw new Error(
        "Confluence URL must belong to the configured internal Confluence host.",
      );
    }
    const pageId = parseConfluencePageId(reference);
    if (pageId) return { pageId, url: reference };
    if (parseDisplayReference(reference)) return { url: reference };
    throw new Error(
      "Confluence URL does not contain a page ID or a resolvable /display/<space>/<title> path.",
    );
  }

  if (!/^\d+$/.test(reference))
    throw new Error("Confluence pageId must be numeric.");
  return {
    pageId: reference,
    url: `${baseUrl.replace(/\/+$/, "")}/pages/viewpage.action?pageId=${encodeURIComponent(reference)}`,
  };
}

export function decodeRestPage(raw: unknown): ConfluencePageDto {
  if (!isRecord(raw))
    throw new Error("Confluence REST response was not an object.");
  const id = stringValue(raw.id);
  const title = stringValue(raw.title);
  const storageHtml = stringValue(asRecord(asRecord(raw.body).storage).value);
  if (!id || !title || !storageHtml) {
    throw new Error(
      "Confluence REST response did not contain id, title, and body.storage.value.",
    );
  }
  const version = asRecord(raw.version);
  const links = asRecord(raw._links);
  const space = asRecord(raw.space);
  return {
    id,
    title,
    storageHtml,
    spaceId: stringValue(space.id) || undefined,
    version: typeof version.number === "number" ? version.number : undefined,
    updatedAt:
      stringValue(version.createdAt) || stringValue(version.when) || undefined,
    url:
      stringValue(links.base) && stringValue(links.webui)
        ? `${stringValue(links.base)}${stringValue(links.webui)}`
        : undefined,
  };
}

export function buildPageContext(
  page: ConfluencePageDto,
  sourceUrl: string,
): PageContext {
  const markdown = htmlToMarkdown(page.storageHtml);
  return {
    id: page.id,
    title: page.title,
    url: page.url ?? sourceUrl,
    spaceId: page.spaceId,
    version: page.version,
    updatedAt: page.updatedAt,
    markdown,
    headings: extractHeadings(markdown),
    links: extractLinks(`${page.title}\n${markdown}`),
  };
}

export function renderConfluencePageMarkdown(page: PageContext): string {
  const lines = [`# ${page.title}`, "", `- URL: ${page.url}`];
  if (page.spaceId) lines.push(`- Space ID: ${page.spaceId}`);
  if (page.version) lines.push(`- Version: ${page.version}`);
  if (page.updatedAt) lines.push(`- Updated: ${page.updatedAt}`);
  if (page.headings.length)
    lines.push(
      "",
      "## Headings",
      ...page.headings.map((heading) => `- ${heading}`),
    );
  if (page.links.figmaUrls.length)
    lines.push(
      "",
      "## Figma Links",
      ...page.links.figmaUrls.map((url) => `- ${url}`),
    );
  if (page.links.jiraKeys.length)
    lines.push(
      "",
      "## Jira Keys",
      ...page.links.jiraKeys.map((key) => `- ${key}`),
    );
  if (page.markdown) lines.push("", "## Content", "", page.markdown);
  return `${lines.join("\n")}\n`;
}

function extractLinks(text: string): ExtractedLinks {
  const urls = [...text.matchAll(/https?:\/\/[^\s)<>]+/g)].map((match) =>
    match[0].replace(/[.,]+$/, ""),
  );
  return {
    urls: [...new Set(urls)],
    figmaUrls: [...new Set(urls.filter((url) => url.includes("figma.com")))],
    jiraKeys: [...new Set(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])],
  };
}

function extractHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(
      /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>(.*?)<\/a>/gis,
      (_match, _quote, href, content) =>
        `[${stripTags(content) || href}](${href})`,
    )
    .replace(
      /<h([1-6])[^>]*>(.*?)<\/h\1>/gis,
      (_match, level, content) =>
        `${"#".repeat(Number(level))} ${stripTags(content)}\n\n`,
    )
    .replace(
      /<li[^>]*>(.*?)<\/li>/gis,
      (_match, content) => `- ${stripTags(content)}\n`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
