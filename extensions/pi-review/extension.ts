/**
 * pi-review Extension
 *
 * Intercepts Edit/Write/MultiEdit tool calls and shows a diff preview in Neovim.
 * The user can review the changes in Neovim before accepting or rejecting.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ToolInput {
  file_path: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  content?: string;
  edits?: Array<{
    old_string?: string;
    new_string?: string;
  }>;
}

// --- Shell Script Helpers ---

const SCRIPT_DIR = path.resolve(__dirname, "bin");

function runShellScript(scriptName: string): string | null {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  const result = child_process.spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    timeout: 1500,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}

let cachedNvimSocket: string | null = null;

function getNvimSocket(): string | null {
  if (cachedNvimSocket && fs.existsSync(cachedNvimSocket)) {
    return cachedNvimSocket;
  }
  const socket =
    process.env.NVIM_SOCKET && fs.existsSync(process.env.NVIM_SOCKET)
      ? process.env.NVIM_SOCKET
      : runShellScript("nvim-socket.sh");
  if (!socket || !fs.existsSync(socket)) {
    return null;
  }
  cachedNvimSocket = socket;
  return socket;
}

function escapeLuaStr(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function nvimSend(luaCmd: string): boolean {
  const socket = getNvimSocket();
  if (!socket) {
    return false;
  }

  try {
    const result = child_process.spawnSync(
      "nvim",
      ["--server", socket, "--remote-send", `:lua ${luaCmd}\n`],
      { timeout: 1500 },
    );
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

// --- Diff Preview ---

async function showDiffPreview(
  toolName: string,
  toolInput: ToolInput,
  cwd: string,
): Promise<void> {
  const socket = getNvimSocket();
  if (!socket) {
    return;
  }

  const filePath = path.resolve(cwd, toolInput.file_path);

  let originalContent = "";
  if (fs.existsSync(filePath)) {
    originalContent = fs.readFileSync(filePath, "utf-8");
  }

  // Write data to a JSON temp file
  const tmpFile = path.join(
    os.tmpdir(),
    `pi-review-${process.pid}-${Date.now()}.json`,
  );
  const payload = {
    originalContent,
    filePath: toolInput.file_path,
    toolName,
    toolInput,
  };
  fs.writeFileSync(tmpFile, JSON.stringify(payload), "utf-8");

  const luaCmd = `require('pi-review.diff').show_diff_from_file('${escapeLuaStr(tmpFile)}')`;
  nvimSend(luaCmd);
}

async function closeDiff(): Promise<void> {
  nvimSend("require('pi-review.diff').close_diff_and_cleanup()");
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Counter to handle concurrent tool calls (race condition safety)
  let diffCount = 0;

  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const toolName = event.toolName;

    // Only intercept Edit, Write, MultiEdit
    if (
      toolName !== "Edit" &&
      toolName !== "Write" &&
      toolName !== "MultiEdit"
    ) {
      return;
    }

    // Skip if no neovim socket
    const socket = getNvimSocket();
    if (!socket) {
      return;
    }

    // Show diff preview in neovim
    const input = event.input as Record<string, unknown>;
    if (typeof input.file_path !== "string") {
      return;
    }
    await showDiffPreview(toolName, input as ToolInput, ctx.cwd);

    // Block and wait for user confirmation
    diffCount++;
    return { block: true };
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (diffCount <= 0) return;

    const toolName = event.toolName;
    if (
      toolName !== "Edit" &&
      toolName !== "Write" &&
      toolName !== "MultiEdit"
    ) {
      return;
    }

    // Close the diff preview
    await closeDiff();
    diffCount--;
  });
}
