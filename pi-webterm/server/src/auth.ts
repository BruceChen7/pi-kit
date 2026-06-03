import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { getConfig } from "./config.js";

// ─── Token Auth ────────────────────────────────────────────────

export function verifyToken(
  expected: string,
  submitted: string | undefined,
): boolean {
  if (!submitted || submitted.length !== expected.length) {
    return false;
  }
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(submitted);
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

    // Ed25519 keys are SPKI DER-encoded by Node.js
    const key = createPublicKey({
      key: publicKeyDer,
      type: "spki",
      format: "der",
    });

    // Ed25519: pass null as algorithm (no hash before sign)
    return verify(null, Buffer.from(message, "utf-8"), key, sig);
  } catch {
    return false;
  }
}

// ─── Middleware ─────────────────────────────────────────────────

export interface AuthRequest {
  headers: { authorization?: string };
  query: { token?: string; sig?: string; msg?: string };
}

function getBearerToken(authHeader?: string): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) {
    return undefined;
  }

  return authHeader.slice(7);
}

export function createAuthMiddleware(config?: {
  publicKey?: string;
  token?: string;
}) {
  return async (req: AuthRequest): Promise<boolean> => {
    const cfg = config || getConfig();

    // 1. Try Bearer token (Authorization header)
    const bearerToken = getBearerToken(req.headers.authorization);
    if (bearerToken && verifyToken(cfg.token || "", bearerToken)) {
      return true;
    }

    // 2. Try token in query parameter
    if (req.query.token && verifyToken(cfg.token || "", req.query.token)) {
      return true;
    }

    // 3. Try Ed25519 signature via query params
    if (req.query.sig && req.query.msg && cfg.publicKey) {
      return verifySignature(cfg.publicKey, req.query.msg, req.query.sig);
    }

    return false;
  };
}
