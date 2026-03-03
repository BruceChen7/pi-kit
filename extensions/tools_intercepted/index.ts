/**
 * Tools Intercepted Extension
 *
 * This extension wraps the bash tool to prepend intercepted-commands to PATH,
 * which contains shim scripts that intercept common commands and redirect
 * agents to use modern alternatives.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected to `uv run python`, with special handling to
 *   block `python -m pip` and `python -m venv`
 * - find: Blocked with suggestions to use `fd` (faster alternative)
 * - grep: Blocked with suggestions to use `rg` (ripgrep, faster alternative)
 *
 * The shim scripts are located in the intercepted-commands directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const bashTool = createBashTool(cwd, {
    commandPrefix: `export PATH="${interceptedCommandsPath}:$PATH"`,
  });

  pi.registerTool(bashTool);
}
