/**
 * Tools Intercepted Extension
 *
 * This extension prepends intercepted-commands to PATH so the built-in bash tool
 * resolves shim scripts that redirect common commands to modern alternatives.
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

import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");

function applyInterceptedPath(): void {
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const entries = currentPath.split(delimiter).filter(Boolean);

  if (entries.includes(interceptedCommandsPath)) {
    return;
  }

  process.env[pathKey] = [interceptedCommandsPath, currentPath]
    .filter(Boolean)
    .join(delimiter);
}

export default function (pi: ExtensionAPI) {
  applyInterceptedPath();

  pi.on("session_start", () => {
    applyInterceptedPath();
  });

  pi.on("session_switch", () => {
    applyInterceptedPath();
  });
}
