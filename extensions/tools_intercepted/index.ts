/**
 * Intercepted Commands Extension
 *
 * Prepends `intercepted-commands` to PATH so a few commands can be blocked or
 * redirected before the real binary runs:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected to `uv run python`, with special handling to
 *   block `python -m pip` and `python -m venv`
 *
 * These shims keep their contract because they **block or redirect**: callers
 * expect the command to be swapped ("don't use pip, use uv").
 *
 * There is deliberately NO grep->rg or find->fd shim. A command that keeps its
 * name but changes its semantics is not a proxy: grep's default is BRE (bare
 * `( ) {} + ? |` are literal) while rg's default is ERE, and rg honours
 * .gitignore while grep does not. A flag-only translation therefore failed two
 * ways on every bash `grep`:
 *   - `rg: regex parse error` + exit 2 on BRE patterns like `it("` or `(script`;
 *   - silent false negatives on `\|` alternation (rg reads a literal pipe) and
 *     on .gitignore'd paths.
 * Across session logs that was 178 failing `grep` invocations, 138 of them
 * reaching the model as non-error output (exit code swallowed by a pipe).
 * bash `grep`/`find` are left to the system implementations.
 *
 * Search tools are not registered here either: pi's built-in `grep`/`find`
 * tools are ripgrep/fd-backed (fetching the binary when it is missing), expose
 * the same parameters, notices and details the removed `rg`/`fd` tools did, and
 * `find` additionally handles glob patterns that contain a path segment (the
 * removed `fd` tool silently returned nothing for those) and non-git
 * directories. Keep those built-ins enabled with
 * `"defaultTools": ["+grep", "+find"]` — `grep`/`find` are not part of pi's
 * default tool set.
 */

import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");

let log: ReturnType<typeof createLogger> | null = null;

/**
 * Shell: prepend the shim directory to PATH, once.
 *
 * Called at load time and on `session_start` (which fires again on reload), so
 * a long-running instance re-applies it even if something replaced PATH.
 */
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

export default function (pi: ExtensionAPI): void {
  log = createLogger("tools-intercepted", { stderr: null });

  applyInterceptedPath("init");

  pi.on("session_start", (event) => {
    applyInterceptedPath(event.reason);
  });
}
