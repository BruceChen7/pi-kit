import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type AiCompletionContext = Pick<ExtensionContext, "model" | "modelRegistry">;

const DESCRIPTION_ID_SYSTEM_PROMPT = `You generate short, stable IDs from a task description.

Rules:
- Output only the ID, no quotes or explanation
- Use lowercase kebab-case
- Keep it concise but descriptive
- Use only letters, numbers, and hyphens
- Prefer 2-5 words
`;

export async function generateKebabCaseIdFromDescription(
  ctx: AiCompletionContext,
  description: string,
): Promise<string | null> {
  if (!ctx.model) {
    return null;
  }

  let mod: unknown;
  try {
    mod = await import("@mariozechner/pi-ai");
  } catch {
    return null;
  }

  if (
    !mod ||
    typeof mod !== "object" ||
    !("complete" in mod) ||
    typeof mod.complete !== "function"
  ) {
    return null;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
    ctx.model as Model<never>,
  );
  if (!auth.ok) {
    return null;
  }

  const complete = mod.complete as (
    model: unknown,
    request: {
      systemPrompt: string;
      messages: Array<{
        role: "user";
        content: Array<{ type: "text"; text: string }>;
        timestamp: number;
      }>;
    },
    options: {
      apiKey?: string;
      headers?: Record<string, string>;
      reasoningEffort?: "low" | "medium" | "high";
    },
  ) => Promise<{
    content?: Array<{ type?: string; text?: string }>;
  }>;

  try {
    const response = await complete(
      ctx.model,
      {
        systemPrompt: DESCRIPTION_ID_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: description.trim() }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoningEffort: ctx.model.reasoning ? "low" : undefined,
      },
    );

    const candidate = (response.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .join("\n")
      .trim();

    return candidate || null;
  } catch {
    return null;
  }
}
