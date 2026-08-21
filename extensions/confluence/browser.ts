import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  buildPageContext,
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

async function resolvePageIdFromDisplayUrl(url: string): Promise<string> {
  const reference = parseDisplayReference(url);
  if (!reference)
    throw new Error(
      "Confluence URL does not contain a resolvable space key and title.",
    );
  const endpoint = `/rest/api/content?spaceKey=${encodeURIComponent(
    reference.spaceKey,
  )}&title=${encodeURIComponent(reference.title)}`;
  const raw = (await evalRest(endpoint)) as {
    results?: Array<{ id?: string }>;
  };
  const found = raw.results?.[0];
  if (!found?.id)
    throw new Error(
      `No Confluence page found for space "${reference.spaceKey}" titled "${reference.title}".`,
    );
  return found.id;
}

export async function fetchConfluencePage(
  url: string,
  pageId?: string,
): Promise<PageContext> {
  await execFile("opencli", ["browser", SESSION, "open", url], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const id = pageId ?? (await resolvePageIdFromDisplayUrl(url));
  const endpoint = `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space`;
  const raw = await evalRest(endpoint);
  return buildPageContext(decodeRestPage(raw), url);
}
