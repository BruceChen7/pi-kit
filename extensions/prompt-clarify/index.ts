/**
 * prompt-clarify — rewrite plain-language prompts into precise technical prompts.
 *
 * Triggers:
 *   /clarify <rough idea> | /prompt-clarify <rough idea>
 *   /clarify               # rewrite current editor text
 *   /clarify revert        # undo last rewrite
 *   ... -clarify           # marker anywhere in a message
 *   ... -prompt-clarify    # alias marker
 *
 * 0-config: always uses the current session model, no file persistence.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hasClarifyMarker, stripClarifyMarker } from "./marker.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

const USAGE =
  "Usage: /clarify <idea> | /clarify | /clarify revert | add -clarify anywhere in the message";

type ClarifyUi = {
  hasUI: boolean;
  mode: string;
  model: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
  ui: ExtensionContext["ui"];
};

type RewriteModel = NonNullable<
  ReturnType<ExtensionContext["modelRegistry"]["find"]>
>;

let lastBefore: string | null = null;

// Exported for testing — reset between tests
export function __resetLastBeforeForTest(): void {
  lastBefore = null;
}

export function __getLastBeforeForTest(): string | null {
  return lastBefore;
}

function resolveRewriteModel(ctx: ClarifyUi): RewriteModel | null {
  if (ctx.model) return ctx.model as RewriteModel;

  if (ctx.hasUI) {
    ctx.ui.notify(
      "No model available for clarify. Select a session model.",
      "error",
    );
  }
  return null;
}

async function callModel(
  text: string,
  model: RewriteModel,
  ctx: ClarifyUi,
  signal?: AbortSignal,
): Promise<string | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok === false) {
    throw new Error(auth.error);
  }
  if (!auth.apiKey) {
    throw new Error(`No API key for ${model.provider}`);
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      cacheRetention: "none",
    },
  );

  if (response.stopReason === "aborted") {
    return null;
  }

  const rewritten = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!rewritten) {
    throw new Error("Clarify returned empty text");
  }

  return rewritten;
}

async function rewritePrompt(
  raw: string,
  ctx: ClarifyUi,
): Promise<string | null> {
  const text = raw.trim();
  if (!text) {
    if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
    return null;
  }

  const model = resolveRewriteModel(ctx);
  if (!model) return null;

  // Interactive TUI can show a loader. Other hosts fall through to a plain call.
  if (ctx.mode === "tui" && ctx.hasUI) {
    const loaded = await ctx.ui.custom<string | null>(
      (tui, theme, _kb, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          `Clarifying with ${model.provider}/${model.id}...`,
        );
        loader.onAbort = () => done(null);

        const run = async () => {
          try {
            const result = await callModel(text, model, ctx, loader.signal);
            done(result);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            ctx.ui.notify(message, "error");
            done(null);
          }
        };

        void run();
        return loader;
      },
    );
    if (loaded !== undefined) return loaded;
  }

  try {
    return await callModel(text, model, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    return null;
  }
}

async function putRewriteInEditor(raw: string, ctx: ClarifyUi): Promise<void> {
  const rewritten = await rewritePrompt(raw, ctx);
  if (rewritten === null) {
    if (ctx.hasUI) ctx.ui.notify("Cancelled", "info");
    return;
  }

  if (ctx.hasUI && typeof ctx.ui.setEditorText === "function") {
    try {
      const prev =
        typeof ctx.ui.getEditorText === "function"
          ? ctx.ui.getEditorText()
          : "";
      lastBefore = String(prev ?? "");
    } catch {
      lastBefore = "";
    }
    ctx.ui.setEditorText(rewritten);
    ctx.ui.notify(
      "Rewrite ready. Edit if needed, then send. Use /clarify revert to undo.",
      "info",
    );
    return;
  }

  ctx.ui.notify(rewritten, "info");
}

function handleRevert(ctx: ClarifyUi): void {
  if (!ctx.hasUI || typeof ctx.ui.setEditorText !== "function") {
    ctx.ui.notify("No editor to revert", "warning");
    return;
  }
  if (lastBefore === null) {
    ctx.ui.notify("Nothing to revert", "warning");
    return;
  }
  ctx.ui.setEditorText(lastBefore);
  ctx.ui.notify("Reverted to previous prompt", "info");
  lastBefore = null;
}

function toClarifyUi(ctx: ExtensionContext): ClarifyUi {
  return {
    hasUI: ctx.hasUI,
    mode: ctx.mode,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    ui: ctx.ui,
  };
}

async function handleClarifyCommand(
  args: string | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  const rawArgs = (args ?? "").trim();
  const parts = rawArgs ? rawArgs.split(/\s+/) : [];

  if (parts[0]?.toLowerCase() === "revert") {
    handleRevert(toClarifyUi(ctx));
    return;
  }

  const ui = toClarifyUi(ctx);
  const fromArgs = rawArgs;
  const fromEditor =
    ctx.hasUI && typeof ctx.ui.getEditorText === "function"
      ? ctx.ui.getEditorText().trim()
      : "";
  const source = fromArgs || fromEditor;

  if (!source) {
    ctx.ui.notify(USAGE, "warning");
    return;
  }

  await putRewriteInEditor(source, ui);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clarify", {
    description:
      "Rewrite a rough idea into a precise technical prompt (result goes in the editor)",
    handler: async (args, ctx) => {
      await handleClarifyCommand(args, ctx);
    },
  });

  pi.registerCommand("prompt-clarify", {
    description:
      "Rewrite a rough idea into a precise technical prompt (alias for /clarify)",
    handler: async (args, ctx) => {
      await handleClarifyCommand(args, ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" };
    }

    const text = event.text;
    if (!hasClarifyMarker(text)) {
      return { action: "continue" };
    }

    const rough = stripClarifyMarker(text);
    if (!rough) {
      if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
      return { action: "handled" };
    }

    await putRewriteInEditor(rough, toClarifyUi(ctx));
    return { action: "handled" };
  });
}
