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
  sessionId?: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const activeSessions = new Map<string, Session>();

/**
 * Generate a session token with embedded expiry and optional sessionId.
 *
 * Token format: <expiresAt_base36>.<sessionId>.<random_hex>
 *
 * Master token (no sessionId): <exp>..<random> — used for REST API calls
 * Session token (with sessionId): <exp>.<sid>.<random> — used for WS auto-attach
 *
 * The expiry is encoded directly in the token so that verifyWsToken
 * can validate it without any I/O or state lookup.
 *
 * The in-memory activeSessions Map is kept for:
 *   - username lookup in getSession()
 *   - revocation tracking via revokedTokens
 */
export function generateSessionToken(
  username: string,
  sessionId?: string,
): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const random = randomBytes(32).toString("hex");
  const sid = sessionId ?? "";
  const token = `${expiresAt.toString(36)}.${sid}.${random}`;
  activeSessions.set(token, {
    username,
    createdAt: Date.now(),
    expiresAt,
    sessionId: sid || undefined,
  });
  return token;
}

/**
 * Decode the embedded expiry from a token string.
 * Returns the expiry timestamp, or 0 if the token format is invalid.
 */
function decodeExpiry(token: string): number {
  const dot = token.indexOf(".");
  if (dot === -1) return 0;
  return Number.parseInt(token.slice(0, dot), 36) || 0;
}

/**
 * Extract the embedded sessionId from a token.
 * Returns undefined for master tokens (no sessionId) or invalid tokens.
 */
export function getSessionIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  // Format: <exp>.<sessionId>.<random>
  if (parts.length < 3) return undefined;
  return parts[1] || undefined;
}

/**
 * Get session info for a token.
 * Checks embedded expiry first (fast path), then looks up the Map.
 */
export function getSession(token: string): Session | undefined {
  if (Date.now() > decodeExpiry(token)) {
    activeSessions.delete(token);
    return undefined;
  }
  return activeSessions.get(token);
}

// Best-effort revocation tracking (in-memory only, lost on restart)
const revokedTokens = new Set<string>();

/**
 * Destroy/revoke a session token (in-memory only, lost on restart).
 */
export function destroySession(token: string): void {
  activeSessions.delete(token);
  revokedTokens.add(token);
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
    if (bearerToken) {
      // Check embedded expiry first (stateless — works after restart)
      if (!verifyWsToken(bearerToken)) {
        return false;
      }
      // Check revocation (best-effort, in-memory only)
      if (revokedTokens.has(bearerToken)) {
        return false;
      }
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
  // Stateless check — the token carries its own expiry
  return Date.now() <= decodeExpiry(token);
}
