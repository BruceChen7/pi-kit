import {
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { getConfig } from "./config.js";

// ─── Session Token Management ──────────────────────────────────

export interface Session {
  username: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const activeSessions = new Map<string, Session>();

export function generateSessionToken(username: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  activeSessions.set(token, {
    username,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return token;
}

export function getSession(token: string): Session | undefined {
  const session = activeSessions.get(token);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return undefined;
  }
  return session;
}

export function destroySession(token: string): void {
  activeSessions.delete(token);
}

// ─── Credential Validation ─────────────────────────────────────

export function validateCredentials(
  expectedUsername: string,
  expectedPassword: string,
  username: string,
  password: string,
): boolean {
  // Use timingSafeEqual to prevent timing attacks on password
  try {
    const userA = Buffer.from(expectedUsername);
    const userB = Buffer.from(username);
    const passA = Buffer.from(expectedPassword);
    const passB = Buffer.from(password);
    return timingSafeEqual(userA, userB) && timingSafeEqual(passA, passB);
  } catch {
    return false;
  }
}

/**
 * Shell wrapper: reads expected credentials from global config.
 */
export function validateCredentialsFromConfig(
  username: string,
  password: string,
): boolean {
  const cfg = getConfig();
  return validateCredentials(cfg.username, cfg.password, username, password);
}

// ─── Bearer Token Helper ──────────────────────────────────────

export function getBearerToken(authHeader?: string): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) return undefined;
  return authHeader.slice(7);
}

// ─── Signature Auth (Ed25519) ──────────────────────────────────

export interface AuthChallenge {
  timestamp: number;
  sessionId: string;
}

export function generateAuthChallenge(sessionId: string): AuthChallenge {
  return {
    timestamp: Date.now(),
    sessionId,
  };
}

export function verifySignature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const publicKeyDer = Buffer.from(publicKeyBase64, "base64");
    const sig = Buffer.from(signatureBase64, "base64");

    const key = createPublicKey({
      key: publicKeyDer,
      type: "spki",
      format: "der",
    });

    return verify(null, Buffer.from(message, "utf-8"), key, sig);
  } catch {
    return false;
  }
}

// ─── Auth Request Types ────────────────────────────────────────

export interface AuthRequest {
  headers: { authorization?: string };
  query: { sig?: string; msg?: string };
}

// ─── Middleware ─────────────────────────────────────────────────

export function createAuthMiddleware(config?: { publicKey?: string }) {
  return async (req: AuthRequest): Promise<boolean> => {
    const cfg = config || getConfig();

    // 1. Try session token via Bearer header
    const bearerToken = getBearerToken(req.headers.authorization);
    if (bearerToken && getSession(bearerToken)) {
      return true;
    }

    // 2. Try Ed25519 signature via query params
    if (req.query.sig && req.query.msg && cfg.publicKey) {
      return verifySignature(cfg.publicKey, req.query.msg, req.query.sig);
    }

    return false;
  };
}

// ─── WebSocket Auth ────────────────────────────────────────────

export interface WsAuthMessage {
  type: "auth";
  token: string;
}

export function authenticateWsMessage(msg: unknown): msg is WsAuthMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as any).type === "auth" &&
    typeof (msg as any).token === "string"
  );
}

export function verifyWsToken(token: string): boolean {
  return !!getSession(token);
}
