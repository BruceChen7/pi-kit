#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, "..");
const MODES = new Set(["doctor", "tool", "command"]);
const DEFAULT_SETTLE_MS = 1200;
const DEFAULT_TIMEOUT_MS = 30_000;
const EVIDENCE_ROOT = ".pi/verify-runs";
const RPC_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-mcp",
  "--no-prompt-templates",
  "--no-themes",
  "--offline",
];
const VALUE_FLAGS = new Set([
  "--plugin",
  "--command",
  "--expect",
  "--reject",
  "--tool",
  "--out",
  "--settle-ms",
  "--timeout-ms",
  "--repo",
]);

const isUnder = (candidate, root) => {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolved === resolvedRoot ||
    resolved.startsWith(`${resolvedRoot}${path.sep}`)
  );
};

/**
 * Parse argv into a run plan. Pure: no filesystem, no clock.
 * Returns a plain DTO so tests can drive it with value in / value out.
 */
export function parseArgs(argv) {
  const mode = argv[0];
  if (!MODES.has(mode)) {
    return {
      ok: false,
      error: `expected a mode (doctor, tool, command), got "${mode ?? ""}"`,
    };
  }

  const options = {
    mode,
    plugin: "",
    commands: [],
    expects: [],
    rejects: [],
    tool: "",
    out: "",
    repo: "",
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag)) {
      return { ok: false, error: `unknown argument "${flag}"` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${flag} needs a value` };
    }
    index += 1;

    switch (flag) {
      case "--plugin":
        options.plugin = value;
        break;
      case "--command":
        options.commands.push(value);
        break;
      case "--expect":
        options.expects.push(value);
        break;
      case "--reject":
        options.rejects.push(value);
        break;
      case "--tool":
        options.tool = value;
        break;
      case "--out":
        options.out = value;
        break;
      case "--repo":
        options.repo = value;
        break;
      case "--settle-ms":
      case "--timeout-ms": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return {
            ok: false,
            error: `${flag} needs a positive integer, got "${value}"`,
          };
        }
        if (flag === "--settle-ms") options.settleMs = parsed;
        else options.timeoutMs = parsed;
        break;
      }
      default:
        return { ok: false, error: `unknown argument "${flag}"` };
    }
  }

  if (!options.plugin) return { ok: false, error: "--plugin is required" };
  if (mode === "tool" && !options.tool) {
    return { ok: false, error: "tool mode needs --tool" };
  }
  if (mode === "command" && options.commands.length === 0) {
    return { ok: false, error: "command mode needs at least one --command" };
  }
  if (mode !== "command") {
    if (options.commands.length > 0) {
      return { ok: false, error: "--command only applies to command mode" };
    }
    if (options.expects.length > 0 || options.rejects.length > 0) {
      return {
        ok: false,
        error: "--expect/--reject only apply to command mode",
      };
    }
  }

  return { ok: true, options };
}

/** "/plan-mode status" -> "plan-mode" */
export const commandNameOf = (slash) =>
  slash.trim().replace(/^\/+/, "").split(/\s+/)[0] ?? "";

/**
 * A command proves the plugin loaded only when it came from the extension we
 * asked for. A same-named command from another source is a different feature.
 */
export const findRegisteredCommand = (commands, name, pluginDir) => {
  const match = (commands ?? []).find((command) => command?.name === name);
  if (!match) {
    return { ok: false, findings: [`command "${name}" is not registered`] };
  }

  const findings = [];
  if (match.source !== "extension") {
    findings.push(
      `command "${name}" is registered by ${match.source ?? "unknown"}, not an extension`,
    );
  }

  const sourcePath = match.sourceInfo?.path;
  if (pluginDir) {
    if (!sourcePath) {
      findings.push(`command "${name}" has no sourceInfo.path`);
    } else if (!isUnder(sourcePath, pluginDir)) {
      findings.push(
        `command "${name}" comes from ${sourcePath}, not ${pluginDir}`,
      );
    }
  }

  return { ok: findings.length === 0, findings };
};

/** Only user-visible notify records count; widgets and status are chrome. */
export const collectNotifies = (records, sinceIndex = 0) =>
  (records ?? [])
    .slice(sinceIndex)
    .filter(
      (record) =>
        record?.method === "notify" && typeof record.message === "string",
    )
    .map((record) => record.message);

export const evaluateRun = ({ dispositions, notifies, expects, rejects }) => {
  const findings = [];
  const messages = notifies ?? [];

  for (const text of expects ?? []) {
    if (!messages.some((message) => message.includes(text))) {
      findings.push(`missing expected text: "${text}"`);
    }
  }
  for (const text of rejects ?? []) {
    if (messages.some((message) => message.includes(text))) {
      findings.push(`unexpected text: "${text}"`);
    }
  }
  for (const disposition of dispositions ?? []) {
    if (disposition !== "handled") {
      findings.push(
        `command was not handled by an extension (disposition: ${disposition ?? "missing"})`,
      );
    }
  }

  return { ok: findings.length === 0, findings };
};

const extensionErrorFindings = (extensionErrors, pluginDir) => {
  const findings = [];
  for (const error of extensionErrors ?? []) {
    if (pluginDir && error?.path && !isUnder(error.path, pluginDir)) continue;
    findings.push(
      `extension load error: ${error?.path ?? "unknown"}: ${error?.error ?? "unknown"}`,
    );
  }
  return findings;
};

export const evaluateToolRun = ({
  activeToolNames,
  expectedTool,
  extensionErrors,
  pluginDir,
}) => {
  const findings = extensionErrorFindings(extensionErrors, pluginDir);
  if (!(activeToolNames ?? []).includes(expectedTool)) {
    findings.push(`tool "${expectedTool}" is not registered`);
  }
  return { ok: findings.length === 0, findings };
};

export const evaluateDoctor = ({
  extensionPaths,
  pluginDir,
  extensionErrors,
}) => {
  const findings = extensionErrorFindings(extensionErrors, pluginDir);
  if (!(extensionPaths ?? []).some((loaded) => isUnder(loaded, pluginDir))) {
    findings.push(`extension is not loaded: ${pluginDir}`);
  }
  return { ok: findings.length === 0, findings };
};

export const formatSummary = (result) => {
  const lines = [
    `${result.ok ? "PASS" : "FAIL"} ${result.mode} ${result.plugin}`,
  ];
  if (result.mode === "command") {
    const steps = result.steps ?? [];
    lines.push(
      `  commands: ${steps.map((step) => `${step.command} -> ${step.disposition}`).join(", ") || "(none)"}`,
    );
    lines.push(`  notifies: ${result.notifies?.length ?? 0}`);
    for (const text of result.expects ?? []) lines.push(`  expected: ${text}`);
  } else {
    if (result.tool) lines.push(`  tool: ${result.tool}`);
    lines.push(`  active tools: ${result.activeToolNames?.length ?? 0}`);
  }
  for (const finding of result.findings ?? []) lines.push(`  - ${finding}`);
  lines.push(`  evidence: ${result.evidenceDir}`);
  return lines.join("\n");
};

const pad = (value) => String(value).padStart(2, "0");
const stamp = (date = new Date()) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const writeEvidence = (directory, files) => {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content, "utf-8");
  }
};

const buildResult = (options, repoRoot, pluginDir, extra) => ({
  mode: options.mode,
  plugin: options.plugin,
  pluginDir,
  evidenceDir:
    options.out.length > 0
      ? path.resolve(options.out)
      : path.join(
          repoRoot,
          EVIDENCE_ROOT,
          `${stamp()}-${options.plugin}-${options.mode}`,
        ),
  ...extra,
});

function spawnRpc(pluginDir, cwd, timeoutMs) {
  const child = spawn("pi", [...RPC_ARGS, "-e", pluginDir], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const records = [];
  const pending = new Map();
  let stderr = "";
  let buffer = "";
  let nextId = 0;
  let fatal = "";

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      records.push(record);
      const waiter = pending.get(record?.id);
      if (record?.type === "response" && waiter) {
        pending.delete(record.id);
        waiter(record);
      }
    }
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    fatal = error.message;
  });
  child.on("exit", (code) => {
    fatal ||= `pi exited early with code ${code}`;
    for (const waiter of pending.values()) {
      waiter({ type: "response", success: false, error: fatal });
    }
    pending.clear();
  });

  const send = (payload) =>
    new Promise((resolve) => {
      if (fatal) {
        resolve({ type: "response", success: false, error: fatal });
        return;
      }
      nextId += 1;
      const id = String(nextId);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({
          type: "response",
          success: false,
          error: `timed out waiting for ${payload.type}`,
        });
      }, timeoutMs);
      pending.set(id, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });

  const stop = async () => {
    // Closing stdin makes pi crash with EPIPE; signal instead.
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(5000).then(() => child.kill("SIGKILL")),
    ]);
  };

  return { send, stop, records, stderr: () => stderr };
}

async function runCommand(options, repoRoot, pluginDir) {
  const session = spawnRpc(pluginDir, repoRoot, options.timeoutMs);
  const notifies = [];
  const steps = [];

  try {
    const commandsResponse = await session.send({ type: "get_commands" });
    if (!commandsResponse.success) {
      return {
        result: buildResult(options, repoRoot, pluginDir, {
          ok: false,
          findings: [
            `get_commands failed: ${commandsResponse.error ?? "unknown"}`,
          ],
          steps,
          notifies,
          expects: options.expects,
        }),
        transcript: session.records,
      };
    }

    const available = commandsResponse.data?.commands ?? [];
    const findings = [];
    const runnable = [];
    for (const command of options.commands) {
      const name = commandNameOf(command);
      const registration = findRegisteredCommand(available, name, pluginDir);
      if (registration.ok) runnable.push(command);
      else findings.push(...registration.findings);
    }

    for (const command of runnable) {
      const mark = session.records.length;
      const response = await session.send({ type: "prompt", message: command });
      const disposition = response.success
        ? (response.data?.disposition ?? "missing")
        : "error";
      steps.push({ command, disposition });
      await sleep(options.settleMs);
      notifies.push(...collectNotifies(session.records, mark));
    }

    const evaluation = evaluateRun({
      dispositions: steps.map((step) => step.disposition),
      notifies,
      expects: options.expects,
      rejects: options.rejects,
    });
    findings.push(...evaluation.findings);

    return {
      result: buildResult(options, repoRoot, pluginDir, {
        ok: findings.length === 0,
        findings,
        steps,
        notifies,
        expects: options.expects,
      }),
      transcript: session.records,
    };
  } finally {
    await session.stop();
  }
}

async function loadSdkSession(repoRoot, pluginDir) {
  let sdk;
  try {
    sdk = await import("@earendil-works/pi-coding-agent");
  } catch {
    throw new Error(
      "cannot import @earendil-works/pi-coding-agent; run npm install first",
    );
  }

  const loader = new sdk.DefaultResourceLoader({
    cwd: repoRoot,
    agentDir: sdk.getAgentDir(),
    noExtensions: true,
    additionalExtensionPaths: [pluginDir],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(),
  });

  return {
    session,
    activeToolNames: session.getActiveToolNames().slice().sort(),
    ...loader.getExtensions(),
  };
}

async function runSdkMode(options, repoRoot, pluginDir) {
  const { session, activeToolNames, extensions, errors } = await loadSdkSession(
    repoRoot,
    pluginDir,
  );

  try {
    const extensionPaths = (extensions ?? [])
      .map((extension) => extension?.path)
      .filter((loaded) => typeof loaded === "string");

    if (options.mode === "doctor") {
      const evaluation = evaluateDoctor({
        extensionPaths,
        pluginDir,
        extensionErrors: errors,
      });
      return buildResult(options, repoRoot, pluginDir, {
        ...evaluation,
        activeToolNames,
        extensionPaths,
      });
    }

    const evaluation = evaluateToolRun({
      activeToolNames,
      expectedTool: options.tool,
      extensionErrors: errors,
      pluginDir,
    });
    return buildResult(options, repoRoot, pluginDir, {
      ...evaluation,
      tool: options.tool,
      activeToolNames,
    });
  } finally {
    session.dispose();
  }
}

export async function main(
  argv,
  io = { log: console.log, error: console.error },
) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.error(`error: ${parsed.error}`);
    return 2;
  }

  const options = parsed.options;
  const repoRoot = path.resolve(options.repo || DEFAULT_REPO_ROOT);
  const pluginDir = path.join(repoRoot, "extensions", options.plugin);

  try {
    if (options.mode === "command") {
      const { result, transcript } = await runCommand(
        options,
        repoRoot,
        pluginDir,
      );
      writeEvidence(result.evidenceDir, {
        "transcript.jsonl": `${transcript.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "summary.json": `${JSON.stringify(result, null, 2)}\n`,
      });
      io.log(formatSummary(result));
      return result.ok ? 0 : 1;
    }

    const result = await runSdkMode(options, repoRoot, pluginDir);
    writeEvidence(result.evidenceDir, {
      "active-tools.json": `${JSON.stringify(result.activeToolNames, null, 2)}\n`,
      "summary.json": `${JSON.stringify(result, null, 2)}\n`,
    });
    io.log(formatSummary(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    io.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
