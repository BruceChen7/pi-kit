import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  port: number;
  host: string;
  cwd: string;
  agentCommand: string;
  autoStartAgent: boolean;
  dataDir: string;
  publicKey: string;
  username: string;
  password: string;
  authRequired: boolean;
}

export interface CliArgs {
  port?: number;
  host?: string;
  cwd?: string;
  agentCommand?: string;
  autoStartAgent?: boolean;
  username?: string;
  password?: string;
  dataDir?: string;
}

let _config: Config | null = null;

// ─── Weak password detection ──────────────────────────────────

const WEAK_PASSWORDS = new Set([
  "admin",
  "password",
  "password123",
  "changeme",
  "change-me",
  "secret",
  "token",
  "123456",
  "12345678",
  "123456789",
]);

export function isStrongPassword(password: string): boolean {
  if (password.length < 8) return false;
  if (WEAK_PASSWORDS.has(password.trim().toLowerCase())) return false;
  if (/^(.)\1+$/.test(password)) return false;
  return true;
}

// ─── Network bind safety ──────────────────────────────────────

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h.startsWith("127.")) return true;
  if (h.startsWith("::ffff:127.")) return true;
  return false;
}

export function isNetworkHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return true;
  if (h === "0.0.0.0" || h === "::" || h === "*") return true;
  if (isLoopbackHost(h)) return false;
  return true;
}

export function assertSafeBindAuthConfig(
  bindHost: string,
  password: string,
): void {
  if (!isNetworkHost(bindHost)) return; // loopback is safe

  if (isStrongPassword(password)) return;

  if (password === "admin" || password.length < 8) {
    throw new Error(
      `Unsafe configuration: BIND_HOST=${bindHost} is network-reachable, but password is too weak. ` +
        `Set a strong password (8+ chars, not common words) or use --password or PI_WEBTERM_PASSWORD.`,
    );
  }
}

// ─── Config helpers ───────────────────────────────────────────

function env(key: string): string | undefined {
  const prefixed = `PI_WEBTERM_${key.toUpperCase()}`;
  return process.env[prefixed] || process.env[key.toUpperCase()];
}

function defaultDataDir(): string {
  return join(homedir(), ".pi", "pi-webterm");
}

/**
 * Expand leading `~` to the user's home directory.
 * Supports `~/path` and `~user/path` (if user is current user).
 */
function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~" || path === "~/" || path === "") {
    return homedir();
  }
  // ~user/... — only expand if user matches current user
  if (path.startsWith("~")) {
    const end = path.indexOf("/");
    const user = end === -1 ? path.slice(1) : path.slice(1, end);
    if (user === homedir().split("/").pop()) {
      return end === -1 ? homedir() : join(homedir(), path.slice(end + 1));
    }
  }
  return path;
}

function ensureDataDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
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
  const dataDir = args.dataDir || env("dataDir") || defaultDataDir();
  const persisted = readPersistedConfig(dataDir);

  const cwd = args.cwd || env("cwd") || process.cwd();
  const resolvedCwd = resolve(expandTilde(cwd));

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

  // Credentials: CLI > env > persisted > defaults
  const username =
    args.username || env("username") || persisted?.username || "admin";
  const password =
    args.password || env("password") || persisted?.password || "admin";

  const authRequired = true; // always require auth

  // Key pair: persist and reuse, or generate
  let publicKey = persisted?.publicKey || "";
  if (!publicKey) {
    const keyPair = generateKeyPair();
    publicKey = keyPair.publicKey;

    persistConfig(dataDir, {
      username,
      password,
      publicKey,
      port,
      host,
      agentCommand,
    });
  }

  _config = {
    port,
    host,
    cwd: resolvedCwd,
    agentCommand,
    autoStartAgent,
    dataDir,
    publicKey,
    username,
    password,
    authRequired,
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
