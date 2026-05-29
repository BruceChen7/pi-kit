import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("cs-search", { stderr: null });

const TOOL_NAME = "cs_search";

type ShellContext = {
  shell?: {
    which?: (name: string) => Promise<string | null>;
    execFile?: (
      command: string,
      args: string[],
      options?: {
        cwd?: string;
        signal?: AbortSignal;
      },
    ) => Promise<{ stdout: string; stderr?: string }>;
  };
};

type Shell = NonNullable<ShellContext["shell"]>;

type CsSearchParams = {
  query: string;
};

type CsSearchResult = {
  location?: string;
  line_number?: number;
  snippet?: string;
  score?: number;
};

const toolParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Search query for ranked structural code search.",
  }),
});

function textResult(text: string): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

function getShell(ctx: ExtensionContext): ShellContext["shell"] {
  return (ctx as ShellContext).shell;
}

function hasBinaryLookup(shell: ShellContext["shell"]): shell is Shell {
  return typeof shell?.which === "function";
}

async function findCsBinary(
  shell: ShellContext["shell"],
): Promise<string | null> {
  return shell?.which?.("cs") ?? null;
}

function formatTopResult(result: CsSearchResult | undefined): string {
  if (!result?.location) {
    return "No results found.";
  }

  const location = result.line_number
    ? `${result.location}:${result.line_number}`
    : result.location;
  const snippet = result.snippet?.trim() || "(no snippet)";
  const score = result.score === undefined ? "" : `\nscore: ${result.score}`;

  return `${location}${score}\n\n${snippet}`;
}

async function executeSearch(
  ctx: ExtensionContext,
  params: CsSearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const shell = getShell(ctx);
  const csPath = await findCsBinary(shell);
  const execFile = shell?.execFile;

  if (!csPath || !execFile) {
    return textResult(
      "cs_search is unavailable because the cs binary is not installed.",
    );
  }

  const { stdout } = await execFile(
    csPath,
    [params.query, "--format", "json"],
    {
      cwd: ctx.cwd,
      signal: ctx.signal,
    },
  );
  const results = JSON.parse(stdout) as CsSearchResult[];

  return textResult(formatTopResult(results[0]));
}

export default function csSearchExtension(pi: ExtensionAPI) {
  let toolRegistered = false;

  const registerTool = (): void => {
    if (toolRegistered) {
      return;
    }

    pi.registerTool({
      name: TOOL_NAME,
      label: "CS Search",
      description:
        "Run ranked structural code search via boyter/cs to find the most relevant implementation, declaration, usage, comment, or string match.",
      promptSnippet:
        "cs_search: ranked structural code search for implementations, definitions, usages, comments, and strings.",
      promptGuidelines: [
        "Use cs_search when you need to find the most relevant implementation, declaration, usage, comment, or string match in code.",
        "Use rg instead when you need exact text or regex line matches.",
      ],
      parameters: toolParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return executeSearch(ctx, params as CsSearchParams);
      },
    });

    toolRegistered = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    const shell = getShell(ctx);
    if (!hasBinaryLookup(shell)) {
      log.warn("cs binary detection unavailable; skipping registration");
      return;
    }

    const csPath = await findCsBinary(shell);
    if (!csPath) {
      log.info("cs binary not found; skipping registration");
      return;
    }

    log.info("cs binary found; registering tool", { csPath });
    registerTool();
  });
}
