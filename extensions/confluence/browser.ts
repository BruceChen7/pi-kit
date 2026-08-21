import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  buildPageContext,
  type DisplayReference,
  decodeRestPage,
  type PageContext,
  parseDisplayReference,
} from "./context";

const execFile = promisify(execFileCallback);
const SESSION = "confluence-sso";

function evalRest(endpoint: string): Promise<unknown> {
  const script = `(()=>fetch(${JSON.stringify(endpoint)}).then(async r=>({status:r.status,text:await r.text()})))()`;
  return execFile("opencli", ["browser", SESSION, "eval", script], {
    maxBuffer: 4 * 1024 * 1024,
  }).then(({ stdout }) => {
    const response = JSON.parse(stdout.trim()) as {
      status: number;
      text: string;
    };
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        `Confluence REST request failed with HTTP ${response.status}.`,
      );
    return JSON.parse(response.text) as unknown;
  });
}

/**
 * Pure: build the REST search endpoint for a /display/<space>/<title> reference.
 * Kept separate from the IO shell so the URL shape is unit-testable.
 */
export function buildDisplaySearchEndpoint(
  reference: DisplayReference,
): string {
  return `/rest/api/content?spaceKey=${encodeURIComponent(
    reference.spaceKey,
  )}&title=${encodeURIComponent(reference.title)}`;
}

/**
 * Pure: pick the first page id from a REST search response.
 * Returns null when the response has no usable result.
 */
export function extractPageIdFromSearch(raw: unknown): string | null {
  const results = (raw as { results?: Array<{ id?: string }> })?.results;
  return results?.[0]?.id ?? null;
}

async function resolvePageIdFromDisplayUrl(
  reference: DisplayReference,
): Promise<string> {
  const raw = await evalRest(buildDisplaySearchEndpoint(reference));
  const id = extractPageIdFromSearch(raw);
  if (!id)
    throw new Error(
      `No Confluence page found for space "${reference.spaceKey}" titled "${reference.title}".`,
    );
  return id;
}

export async function fetchConfluencePage(
  url: string,
  pageId?: string,
  display?: DisplayReference,
): Promise<PageContext> {
  await execFile("opencli", ["browser", SESSION, "open", url], {
    maxBuffer: 2 * 1024 * 1024,
  });
  let id = pageId;
  if (!id) {
    const reference = display ?? parseDisplayReference(url);
    if (!reference)
      throw new Error(
        "Confluence URL does not contain a resolvable space key and title.",
      );
    id = await resolvePageIdFromDisplayUrl(reference);
  }
  const endpoint = `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space`;
  const raw = await evalRest(endpoint);
  return buildPageContext(decodeRestPage(raw), url);
}
