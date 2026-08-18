import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildPageContext, decodeRestPage, type PageContext } from "./context";

const execFile = promisify(execFileCallback);
const SESSION = "confluence-sso";

export async function fetchConfluencePage(
  url: string,
  pageId: string,
): Promise<PageContext> {
  await execFile("opencli", ["browser", SESSION, "open", url], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const endpoint = `/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space`;
  const script = `(()=>fetch(${JSON.stringify(endpoint)}).then(async r=>({status:r.status,text:await r.text()})))()`;
  const { stdout } = await execFile(
    "opencli",
    ["browser", SESSION, "eval", script],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout.trim()) as {
    status: number;
    text: string;
  };
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Confluence REST request failed with HTTP ${response.status}.`,
    );
  const raw = JSON.parse(response.text) as unknown;
  return buildPageContext(decodeRestPage(raw), url);
}
