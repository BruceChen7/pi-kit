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
import { customPanel, hasRichUi, uiHostProfile } from "../shared/rich-ui.ts";
import { hasClarifyMarker, stripClarifyMarker } from "./marker.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

const USAGE =
  "Usage: /clarify <idea> | /clarify | /clarify revert | add -clarify anywhere in the message";

/** 宿主读不到输入框草稿时的提示（pi-web 的 getEditorText() 恒为 ""）。 */
const USAGE_NO_COMPOSER_READ =
  "This host cannot read the composer — pass the text explicitly: /clarify <idea>";

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

  // A host that owns the editor can show a loader. Other hosts (native RPC
  // clients included) fall through to a plain call.
  if (hasRichUi(ctx)) {
    const loaded = await customPanel<string | null>(
      ctx,
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
    // 只有宿主真能读回草稿时才记旧值：pi-web 的 getEditorText() 恒为 ""，
    // 把它当“编辑器是空的”会让 /clarify revert 抹掉用户正在写的草稿。
    lastBefore = uiHostProfile(ctx).editorText.read
      ? readEditorText(ctx)
      : null;
    ctx.ui.setEditorText(rewritten);
    ctx.ui.notify(
      lastBefore === null
        ? "Rewrite ready. Edit if needed, then send. (This host cannot restore the previous draft, so /clarify revert is unavailable.)"
        : "Rewrite ready. Edit if needed, then send. Use /clarify revert to undo.",
      "info",
    );
    return;
  }

  ctx.ui.notify(rewritten, "info");
}

/** 读输入框草稿；宿主没有这个能力时不要假装它是空的（见 putRewriteInEditor）。 */
function readEditorText(ctx: ClarifyUi): string {
  try {
    return String(ctx.ui.getEditorText?.() ?? "");
  } catch {
    return "";
  }
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
  const canReadComposer = uiHostProfile(ctx).editorText.read;
  const fromEditor =
    ctx.hasUI && canReadComposer && typeof ctx.ui.getEditorText === "function"
      ? ctx.ui.getEditorText().trim()
      : "";
  const source = fromArgs || fromEditor;

  if (!source) {
    ctx.ui.notify(canReadComposer ? USAGE : USAGE_NO_COMPOSER_READ, "warning");
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
