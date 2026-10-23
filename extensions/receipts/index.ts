import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  checkReceipts,
  classifyTestCommand,
  extractPublishMessage,
  extractTestClaim,
  isPublishCommand,
  parseTestCounts,
} from "./parse.js";
import { appendReceipt, readReceipts, receiptsPath } from "./store.js";

type BashCall = { toolName: string; input: Record<string, unknown> };
type BashResult = BashCall & {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError: boolean;
};

const commandOf = (input: Record<string, unknown>): string =>
  typeof input.command === "string" ? input.command : "";

const outputOf = (event: BashResult): string => {
  const structured = event.structuredContent as
    | { output?: unknown }
    | undefined;
  if (typeof structured?.output === "string") {
    return structured.output;
  }
  return event.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
};

const exitCodeOf = (event: BashResult): number => {
  const structured = event.structuredContent as
    | { exit_code?: unknown }
    | undefined;
  if (typeof structured?.exit_code === "number") {
    return structured.exit_code;
  }
  return event.isError ? 1 : 0;
};

export default function receipts(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") {
      return {};
    }
    const command = commandOf(event.input);
    if (!classifyTestCommand(command)) {
      return {};
    }
    const counts = parseTestCounts(outputOf(event as unknown as BashResult));
    if (!counts) {
      return {};
    }
    const file = receiptsPath(ctx.cwd);
    if (!file) {
      return {};
    }
    appendReceipt(file, {
      command: command.trim(),
      passed: counts.passed,
      failed: counts.failed,
      exitCode: exitCodeOf(event as unknown as BashResult),
      at: new Date().toISOString(),
    });
    return {};
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName !== "bash") {
      return {};
    }
    if (process.env.PI_RECEIPT_GATE === "off") {
      return {};
    }
    const command = commandOf(event.input);
    if (!isPublishCommand(command)) {
      return {};
    }
    const message = extractPublishMessage(command);
    if (!message) {
      return {};
    }
    const claim = extractTestClaim(message);
    if (!claim) {
      return {};
    }
    const file = receiptsPath(ctx.cwd);
    const verdict = checkReceipts(claim, file ? readReceipts(file) : []);
    if (verdict.ok) {
      return {};
    }
    return { block: true, reason: `receipt gate: ${verdict.reason}` };
  });
}
