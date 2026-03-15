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
import { createLogger } from "../shared/logger.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");

let log: ReturnType<typeof createLogger> | null = null;

function applyInterceptedPath(reason: string): void {
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const entries = currentPath.split(delimiter).filter(Boolean);

  if (entries.includes(interceptedCommandsPath)) {
    log?.debug("Intercepted commands path already applied", {
      reason,
      pathKey,
      interceptedCommandsPath,
    });
    return;
  }

  process.env[pathKey] = [interceptedCommandsPath, currentPath]
    .filter(Boolean)
    .join(delimiter);

  log?.info("Prepended intercepted commands path", {
    reason,
    pathKey,
    interceptedCommandsPath,
  });
}

export default function (pi: ExtensionAPI) {
  log = createLogger("tools-intercepted", { stderr: null });

  applyInterceptedPath("init");

  pi.on("session_start", () => {
    applyInterceptedPath("session_start");
  });

  pi.on("session_switch", () => {
    applyInterceptedPath("session_switch");
  });
}
