import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface Config {
  port: number;
  host: string;
  cwd: string;
  tmuxSessionName: string;
  agentCommand: string;
  autoStartAgent: boolean;
  dataDir: string;
  publicKey: string;
  token: string;
}

export interface CliArgs {
  port?: number;
  host?: string;
  cwd?: string;
  tmuxSessionName?: string;
  agentCommand?: string;
  autoStartAgent?: boolean;
  token?: string;
}

let _config: Config | null = null;

function env(key: string): string | undefined {
  // PI_WEBTERM_PORT → PI_WEBTERM_ prefix
  const prefixed = `PI_WEBTERM_${key.toUpperCase()}`;
  return process.env[prefixed] || process.env[key.toUpperCase()];
}

function defaultDataDir(): string {
  return join(homedir(), ".pi", "pi-webterm");
}

function ensureDataDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateToken(): string {
  return randomBytes(24).toString("hex");
}

function generateKeyPair(): { publicKey: string } {
  const { publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: Buffer.from(publicKey).toString("base64"),
  };
}

function readPersistedConfig(dataDir: string): Partial<Config> | null {
  const configPath = join(dataDir, "config.json");
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return null;
    }
  }
  return null;
}

function persistConfig(dataDir: string, cfg: Partial<Config>): void {
  ensureDataDir(dataDir);
  const configPath = join(dataDir, "config.json");
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

export function loadConfig(args: CliArgs = {}): Config {
  const dataDir = defaultDataDir();
  const persisted = readPersistedConfig(dataDir);

  const cwd = args.cwd || env("cwd") || process.cwd();
  const resolvedCwd = resolve(cwd);

  const tmuxSessionName =
    args.tmuxSessionName ||
    env("tmuxSessionName") ||
    `pw:${basename(resolvedCwd)}`;

  const agentCommand =
    args.agentCommand || env("agent") || persisted?.agentCommand || "pi";

  const port =
    args.port ??
    (env("port") ? Number(env("port")) : undefined) ??
    persisted?.port ??
    4730;

  const host = args.host || env("host") || persisted?.host || "0.0.0.0";

  const autoStartAgent =
    args.autoStartAgent ?? env("autoStartAgent") !== "false";

  // Token: CLI > env > persisted > auto-generate
  let token = args.token || env("token") || persisted?.token || "";

  // Key pair: persist and reuse, or generate
  let publicKey = persisted?.publicKey || "";

  if (!token) {
    token = generateToken();
  }

  if (!publicKey) {
    const keyPair = generateKeyPair();
    publicKey = keyPair.publicKey;

    persistConfig(dataDir, { token, publicKey, port, host, agentCommand });
  }

  _config = {
    port,
    host,
    cwd: resolvedCwd,
    tmuxSessionName,
    agentCommand,
    autoStartAgent,
    dataDir,
    publicKey,
    token,
  };

  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
