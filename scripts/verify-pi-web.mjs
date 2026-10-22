#!/usr/bin/env node
/**
 * Isolated pi-web instance for verifying pi-kit extensions in a browser host.
 *
 * Functional core: parseArgs / buildPlan / classifyCommands are value in, value
 * out. The imperative shell (spawn, symlink, fetch, kill) only wires them.
 *
 * Usage:
 *   node scripts/verify-pi-web.mjs serve --plugin skill-toggle --port 30242
 *   node scripts/verify-pi-web.mjs doctor --run-dir <runDir> --plugin skill-toggle
 *   node scripts/verify-pi-web.mjs stop --run-dir <runDir>
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const DEFAULT_PORT = 30242;
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 400;
const COMMANDS = new Set(["serve", "doctor", "stop"]);
const VALUE_FLAGS = new Set([
  "--plugin",
  "--port",
  "--cwd",
  "--run-dir",
  "--bin",
  "--expect-command",
  "--timeout-ms",
]);

/**
 * Parse argv into a command + options. Pure: no fs, no clock, no env reads.
 */
export function parseArgs(argv, cwd = process.cwd()) {
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    return {
      ok: false,
      error: `expected a command (serve, doctor, stop), got "${command ?? ""}"`,
    };
  }
  const options = {
    command,
    plugins: [],
    expectCommands: [],
    port: DEFAULT_PORT,
    cwd,
    runDir: undefined,
    bin: "pi-web",
    timeoutMs: READY_TIMEOUT_MS,
  };
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!VALUE_FLAGS.has(flag)) {
      return { ok: false, error: `unknown flag: ${flag}` };
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${flag} needs a value` };
    }
    i += 1;
    if (flag === "--plugin") options.plugins.push(value);
    else if (flag === "--expect-command") options.expectCommands.push(value);
    else if (flag === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { ok: false, error: `--port must be 1-65535, got "${value}"` };
      }
      options.port = port;
    } else if (flag === "--timeout-ms") {
      const timeoutMs = Number(value);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return {
          ok: false,
          error: `--timeout-ms must be positive, got "${value}"`,
        };
      }
      options.timeoutMs = timeoutMs;
    } else if (flag === "--cwd") options.cwd = path.resolve(value);
    else if (flag === "--run-dir") options.runDir = path.resolve(value);
    else if (flag === "--bin") options.bin = value;
  }
  return { ok: true, options };
}

/** Run directory name: newest first when listed, no clock inside the pure part. */
export function runDirName(plugins, stamp) {
  const label = plugins.length > 0 ? plugins.join("+") : "pi-web";
  return `${stamp}-${label}`;
}

/**
 * Everything the shell needs to create an isolated instance, as plain data.
 * `extensionLinks` is what makes the plugin set explicit instead of inherited
 * from the user's ~/.pi/agent/extensions.
 */
export function buildPlan(options, stamp) {
  const port = options.port;
  if (options.plugins.length === 0) {
    return { ok: false, error: "at least one --plugin is required for serve" };
  }
  const duplicate = options.plugins.find(
    (p, i) => options.plugins.indexOf(p) !== i,
  );
  if (duplicate) {
    return { ok: false, error: `duplicate --plugin ${duplicate}` };
  }
  const runDir =
    options.runDir ??
    path.join(
      REPO_ROOT,
      ".pi",
      "verify-runs",
      runDirName(options.plugins, stamp),
    );
  const agentDir = path.join(runDir, "agent");
  const names = ["shared", ...options.plugins.filter((p) => p !== "shared")];
  return {
    ok: true,
    plan: {
      port,
      cwd: options.cwd,
      bin: options.bin,
      runDir,
      agentDir,
      evidenceDir: path.join(runDir, "evidence"),
      logPath: path.join(runDir, "pi-web.log"),
      extensionLinks: names.map((name) => ({
        link: path.join(agentDir, "extensions", name),
        target: path.join(REPO_ROOT, "extensions", name),
      })),
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: options.timeoutMs,
    },
  };
}

/**
 * Split pi's command list into "loaded from this run's isolated agent dir" and
 * "everything else". Only the first group proves the plugin under test loaded.
 */
export function classifyCommands(commands, agentDir) {
  const root = path.resolve(agentDir, "extensions");
  const loaded = [];
  const other = [];
  for (const entry of commands) {
    if (!entry || typeof entry.name !== "string") continue;
    const sourcePath = entry.sourceInfo?.path;
    if (
      typeof sourcePath === "string" &&
      path.resolve(sourcePath).startsWith(`${root}${path.sep}`)
    ) {
      const plugin = path
        .relative(root, path.resolve(sourcePath))
        .split(path.sep)[0];
      loaded.push({ name: entry.name, plugin, path: path.resolve(sourcePath) });
    } else {
      other.push(entry.name);
    }
  }
  return { loaded, other };
}

/** Verdict for a doctor run. Missing plugins and missing commands are separate. */
export function judge({ plugins, expectedCommands, loaded }) {
  const loadedPlugins = new Set(loaded.map((entry) => entry.plugin));
  const loadedCommands = new Set(loaded.map((entry) => entry.name));
  const missingPlugins = plugins.filter((plugin) => !loadedPlugins.has(plugin));
  const missingCommands = expectedCommands.filter(
    (command) => !loadedCommands.has(command),
  );
  const ok = missingPlugins.length === 0 && missingCommands.length === 0;
  const reasons = [];
  if (missingPlugins.length > 0)
    reasons.push(`plugin not loaded: ${missingPlugins.join(", ")}`);
  if (missingCommands.length > 0)
    reasons.push(`command not registered: ${missingCommands.join(", ")}`);
  return { ok, reasons, missingPlugins, missingCommands };
}

const stampNow = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 2000) };
  }
  return { status: response.status, body };
}

async function waitFor(fn, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.ok) return last;
    await sleep(pollMs);
  }
  return last ?? { ok: false, error: "timed out" };
}

async function portAnswers(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      signal: AbortSignal.timeout(2000),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

async function serve(options) {
  const built = buildPlan(options, stampNow());
  if (!built.ok) fail(built.error);
  const plan = built.plan;
  const missing = options.plugins.filter(
    (plugin) => !fs.existsSync(path.join(REPO_ROOT, "extensions", plugin)),
  );
  if (missing.length > 0) fail(`no such extension: ${missing.join(", ")}`);
  if (await portInUse(plan.port)) {
    fail(
      `port ${plan.port} is already in use; pick another with --port. Do not stop an instance this run did not start.`,
    );
  }
  fs.mkdirSync(plan.evidenceDir, { recursive: true });
  for (const link of plan.extensionLinks) {
    fs.mkdirSync(path.dirname(link.link), { recursive: true });
    fs.rmSync(link.link, { force: true });
    fs.symlinkSync(link.target, link.link, "dir");
  }
  const log = fs.openSync(plan.logPath, "w");
  const child = spawn(plan.bin, ["--port", String(plan.port), "--no-open"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: plan.agentDir,
      PI_WEB_NO_OPEN: "1",
      PI_WEB_SKIP_VERSION_CHECK: "1",
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  const ready = await waitFor(
    () => portAnswers(plan.baseUrl),
    plan.timeoutMs,
    POLL_MS,
  );
  if (!ready.ok) {
    killQuietly(child.pid);
    fail(
      `pi-web did not answer ${plan.baseUrl}/api/sessions within ${plan.timeoutMs}ms; see ${plan.logPath}`,
    );
  }
  const launch = {
    port: plan.port,
    pid: child.pid,
    baseUrl: plan.baseUrl,
    cwd: plan.cwd,
    agentDir: plan.agentDir,
    runDir: plan.runDir,
    evidenceDir: plan.evidenceDir,
    logPath: plan.logPath,
    plugins: options.plugins,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(plan.runDir, "launch.json"),
    `${JSON.stringify(launch, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, ...launch }, null, 2));
}

function readLaunch(runDir) {
  const file = path.join(runDir, "launch.json");
  if (!fs.existsSync(file))
    fail(`no launch.json in ${runDir}; run serve first`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function doctor(options) {
  if (!options.runDir) fail("doctor needs --run-dir (printed by serve)");
  const launch = readLaunch(options.runDir);
  const pluginFilter =
    options.plugins.length > 0 ? options.plugins : launch.plugins;
  const created = await fetchJson(`${launch.baseUrl}/api/agent/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: options.cwd ?? launch.cwd,
      type: "ensure_session",
    }),
  });
  const sessionId = created.body?.sessionId;
  if (!sessionId) {
    fail(
      `ensure_session failed (${created.status}): ${JSON.stringify(created.body).slice(0, 400)}`,
    );
  }
  const commands = await fetchJson(`${launch.baseUrl}/api/agent/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "get_commands" }),
  });
  const list = commands.body?.data?.commands;
  if (!Array.isArray(list)) {
    fail(
      `get_commands failed (${commands.status}): ${JSON.stringify(commands.body).slice(0, 400)}`,
    );
  }
  const { loaded, other } = classifyCommands(list, launch.agentDir);
  const verdict = judge({
    plugins: pluginFilter,
    expectedCommands: options.expectCommands,
    loaded,
  });
  const record = {
    ok: verdict.ok,
    reasons: verdict.reasons,
    sessionId,
    cwd: options.cwd ?? launch.cwd,
    plugins: pluginFilter,
    loaded,
    otherCommandCount: other.length,
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(launch.runDir, "commands.json"),
    `${JSON.stringify(list, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(launch.runDir, "doctor.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(JSON.stringify(record, null, 2));
  if (!verdict.ok) process.exitCode = 1;
}

function killQuietly(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function stop(options) {
  let launch;
  if (options.runDir) launch = readLaunch(options.runDir);
  else fail("stop needs --run-dir (printed by serve)");
  killQuietly(launch.pid);
  const freed = await waitFor(
    async () => ({ ok: !(await portInUse(launch.port)) }),
    20_000,
    POLL_MS,
  );
  const result = {
    ok: freed.ok,
    pid: launch.pid,
    port: launch.port,
    runDir: launch.runDir,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!freed.ok) process.exitCode = 1;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) fail(parsed.error);
  if (parsed.options.command === "serve") await serve(parsed.options);
  else if (parsed.options.command === "doctor") await doctor(parsed.options);
  else await stop(parsed.options);
}
