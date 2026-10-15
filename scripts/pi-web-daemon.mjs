#!/usr/bin/env node
/**
 * Start Pi Web detached from the terminal, so closing the terminal window or
 * tab does not stop the server.
 *
 * Usage: node scripts/pi-web-daemon.mjs [start|restart] [options]
 *        (or `make pi-web` / `make pi-web-restart`)
 *
 * Options:
 *   -p, --port <port>   Server port (default 30141, or PORT)
 *       --cwd <dir>     Server working directory (default: current dir)
 *       --bin <path>    pi-web executable (default `pi-web`, or PI_WEB_BIN)
 *       --log <path>    File for server stdout/stderr (default /tmp/pi-web.log,
 *                       or PI_WEB_LOG)
 *       --force         Restart an instance that already uses the port
 *       --no-open       Do not open a browser (default: open, like `pi-web`)
 *   -h, --help          Show this help
 *
 * Why detached: `nohup pi-web &` leaves the process in the terminal's process
 * group, and closing a macOS terminal window kills that whole group. A
 * detached spawn gives Pi Web its own session (PPID=1, own PGID), so the
 * terminal can no longer reach it.
 *
 * Functional Core / Imperative Shell: parseArgs / parseStatus / decideStart /
 * startPlan are pure (value in / value out, exported for tests); main() is the
 * thin IO shell that runs `pi-web`, spawns the detached server, and polls the
 * health endpoint.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 30141;
export const DEFAULT_LOG = "/tmp/pi-web.log";
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 250;

const USAGE = `Usage: node scripts/pi-web-daemon.mjs [start|restart] [options]

Start Pi Web detached from the terminal (closing the terminal keeps it alive).

Commands:
  start        Start the server (default); no-op when the port is already in use
  restart      Stop the instance on the port, then start it detached

Options:
  -p, --port <port>   Server port (default ${DEFAULT_PORT}, or PORT)
      --cwd <dir>     Server working directory (default: current dir)
      --bin <path>    pi-web executable (default "pi-web", or PI_WEB_BIN)
      --log <path>    File for server output (default ${DEFAULT_LOG}, or PI_WEB_LOG)
      --force         Restart an instance that already uses the port
      --no-open       Do not open a browser (default: open, like "pi-web")
  -h, --help          Show this help`;

/**
 * Parse argv/env into Options. `cwd` is injected (Shell passes `process.cwd()`)
 * so the pure part never reads a global.
 * @returns {{ ok: true, options: object } | { ok: false, error: string }}
 */
export function parseArgs(argv, env = {}, cwd = process.cwd()) {
  const options = {
    command: "start",
    port: Number(env.PORT) > 0 ? Number(env.PORT) : DEFAULT_PORT,
    cwd: env.PI_WEB_CWD || cwd,
    bin: env.PI_WEB_BIN || "pi-web",
    logPath: env.PI_WEB_LOG || DEFAULT_LOG,
    force: false,
    open: true,
    help: false,
  };

  const args = [...argv];
  const command = args[0];
  if (command && !command.startsWith("-")) {
    args.shift();
    if (command === "start" || command === "restart") {
      options.command = command;
    } else if (command === "help") {
      options.help = true;
    } else {
      return { ok: false, error: `unknown command: ${command}` };
    }
  }

  const takeValue = () => {
    const value = args.shift();
    return value && !value.startsWith("-") ? value : undefined;
  };

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-p":
      case "--port": {
        const value = takeValue();
        if (!value || !/^\d+$/u.test(value)) {
          return { ok: false, error: `${flag} needs a port number` };
        }
        options.port = Number(value);
        break;
      }
      case "--cwd": {
        const value = takeValue();
        if (!value) return { ok: false, error: `${flag} needs a directory` };
        options.cwd = value;
        break;
      }
      case "--bin": {
        const value = takeValue();
        if (!value) return { ok: false, error: `${flag} needs a path` };
        options.bin = value;
        break;
      }
      case "--log": {
        const value = takeValue();
        if (!value) return { ok: false, error: `${flag} needs a path` };
        options.logPath = value;
        break;
      }
      case "--force":
        options.force = true;
        break;
      case "--no-open":
        options.open = false;
        break;
      default:
        return { ok: false, error: `unknown option: ${flag}` };
    }
  }

  return { ok: true, options };
}

/** Parse `pi-web status` output into plain records. */
export function parseStatus(stdout) {
  const servers = [];
  for (const line of String(stdout).split("\n")) {
    const match = line.match(
      /^\s*(https?:\/\/\S+)\s+pid\s+(\d+)\s+v(\S+)\s+started\s+(\S+)/u,
    );
    if (!match) continue;
    const [, url, pid, version, startedAt] = match;
    servers.push({
      url,
      pid: Number(pid),
      version,
      startedAt,
      port: portOf(url),
    });
  }
  return servers;
}

function portOf(url) {
  const parsed = new URL(url);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

/**
 * Decide what to do for the requested port.
 * @returns {{ action: "start" | "already-running" | "stop-then-start", reason: string, server?: object }}
 */
export function decideStart({ running, port, force }) {
  const samePort = running.filter((server) => server.port === port);
  if (samePort.length === 0) {
    return {
      action: "start",
      reason:
        running.length === 0 ? "no server running" : `port ${port} is free`,
    };
  }

  const [server] = samePort;
  if (force) {
    return {
      action: "stop-then-start",
      reason: `pid ${server.pid} on port ${port}`,
      server,
    };
  }
  return {
    action: "already-running",
    reason: `${server.url} (pid ${server.pid}, v${server.version})`,
    server,
  };
}

/** Build the detached spawn plan for pi-web. */
export function startPlan(options) {
  const args = ["--port", String(options.port)];
  if (!options.open) args.push("--no-open");
  return {
    bin: options.bin,
    args,
    cwd: options.cwd,
    logPath: options.logPath,
    url: `http://127.0.0.1:${options.port}/`,
  };
}

function runPiWeb(bin, args) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, code: undefined, message: undefined };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      code: error.code,
      message: error.message.split("\n")[0],
    };
  }
}

function spawnDetached(plan) {
  const logFd = fs.openSync(plan.logPath, "a");
  try {
    const child = spawn(plan.bin, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

async function waitForHealthy(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}

/** IO shell: run pi-web, spawn the detached server, verify it answers. */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  io = console,
) {
  const parsed = parseArgs(argv, env, process.cwd());
  if (!parsed.ok) {
    io.error(`pi-web-daemon: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const options = parsed.options;
  if (options.help) {
    io.log(USAGE);
    return 0;
  }

  const status = runPiWeb(options.bin, ["status"]);
  if (!status.ok && status.code === "ENOENT") {
    io.error(`pi-web-daemon: cannot run "${options.bin}" (not found in PATH)`);
    return 1;
  }

  const decision = decideStart({
    running: parseStatus(status.stdout),
    port: options.port,
    force: options.force || options.command === "restart",
  });

  if (decision.action === "already-running") {
    io.log(`pi-web is already running: ${decision.reason}`);
    io.log(
      "Use `make pi-web-restart` to restart it, or `make pi-web-stop` to stop it.",
    );
    return 0;
  }

  if (decision.action === "stop-then-start") {
    io.log(`Stopping pi-web ${decision.reason}...`);
    const stopped = runPiWeb(options.bin, [
      "stop",
      "--port",
      String(options.port),
    ]);
    if (!stopped.ok) {
      io.error(`pi-web-daemon: stop failed: ${stopped.message}`);
      return 1;
    }
  }

  const plan = startPlan(options);
  const pid = spawnDetached(plan);
  const healthy = await waitForHealthy(plan.url);

  io.log(`pi-web started detached (pid ${pid})`);
  io.log(`  url: ${plan.url}`);
  io.log(`  log: ${plan.logPath}`);
  io.log(`  browser: ${options.open ? "opening" : "not opened (--no-open)"}`);

  if (!healthy) {
    io.error(
      `pi-web-daemon: ${plan.url} did not answer within ${HEALTH_TIMEOUT_MS / 1000}s — check ${plan.logPath}`,
    );
    return 1;
  }
  return 0;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exit(await main());
}
