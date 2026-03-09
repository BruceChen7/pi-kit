import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * skill-status extension
 *
 * Shows detected skill in status bar and emits debug logs so we can diagnose why
 * status updates may not appear.
 */
export default function skillStatusExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    logDebug("session_start: initialize and clear status");
    clearSkillStatus(ctx, "session_start");
  });

  pi.on("session_switch", async (event, ctx) => {
    logDebug(`session_switch: reason=${event.reason}`);
    clearSkillStatus(ctx, "session_switch");
  });

  // Earliest user text hook
  pi.on("input", async (event, ctx) => {
    const skillName = parseSkillFromText(event.text);
    logDebug(
      `input: source=${event.source}, textLen=${event.text.length}, skill=${skillName ?? "none"}`,
      {
        preview: previewText(event.text),
      },
    );

    if (skillName) {
      setSkillStatus(ctx, skillName, "input");
    } else {
      clearSkillStatus(ctx, "input_no_skill");
    }

    return { action: "continue" };
  });

  // Prompt right before model call (often where skill-injected text can be seen)
  pi.on("before_agent_start", async (event, ctx) => {
    const skillName = parseSkillFromText(event.prompt);
    logDebug(
      `before_agent_start: promptLen=${event.prompt.length}, skill=${skillName ?? "none"}`,
      {
        preview: previewText(event.prompt),
      },
    );

    if (skillName) {
      setSkillStatus(ctx, skillName, "before_agent_start");
    }
  });

  // Extra signal for turn lifecycle
  pi.on("turn_start", async (event) => {
    logDebug(`turn_start: turnIndex=${event.turnIndex}`);
  });

  pi.on("turn_end", async (event) => {
    logDebug(
      `turn_end: turnIndex=${event.turnIndex}, messageType=${event.message.type}`,
    );
  });

  // Clear status after full agent loop
  pi.on("agent_end", async (event, ctx) => {
    logDebug(`agent_end: messages=${event.messages.length}, clear status`);
    clearSkillStatus(ctx, "agent_end");
  });
}

function setSkillStatus(
  ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
  skillName: string,
  source: string,
): void {
  try {
    ctx.ui.setStatus("skill", `[skill: ${skillName}]`);
    logDebug(`setStatus: source=${source}, skill=${skillName}`);
  } catch (error) {
    logError(`setStatus failed: source=${source}, skill=${skillName}`, error);
  }
}

function clearSkillStatus(
  ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
  source: string,
): void {
  try {
    ctx.ui.setStatus("skill", undefined);
    logDebug(`clearStatus: source=${source}`);
  } catch (error) {
    logError(`clearStatus failed: source=${source}`, error);
  }
}

/**
 * Parse skill name from text.
 * Supported patterns:
 * 1) <skill name="skill-name" ...>
 * 2) <skill ...> ... name: skill-name ... </skill>
 */
function parseSkillFromText(text: string): string | null {
  const tagAttrMatch = text.match(/<skill\s+name="([^"]+)"/i);
  if (tagAttrMatch?.[1]) {
    return tagAttrMatch[1];
  }

  const blockMatch = text.match(/<skill\b[\s\S]*?<\/skill>/i);
  if (blockMatch) {
    const nameLineMatch = blockMatch[0].match(/\bname\s*:\s*([^\s<\n\r]+)/i);
    if (nameLineMatch?.[1]) {
      return nameLineMatch[1];
    }
  }

  return null;
}

function previewText(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function logDebug(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.debug(`[skill-status] ${message}`, details);
    return;
  }
  console.debug(`[skill-status] ${message}`);
}

function logError(message: string, error: unknown): void {
  console.error(`[skill-status] ${message}`, error);
}
