import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authenticateWsMessage,
  createAuthMiddleware,
  destroySession,
  generateAuthChallenge,
  generateSessionToken,
  getBearerToken,
  getSession,
  getSessionIdFromToken,
  validateCredentials,
  verifySignature,
  verifyWsToken,
} from "../auth.js";
import { isStrongPassword, loadConfig, resetConfig } from "../config.js";

// ─── Credential Validation ─────────────────────────────────────

describe("validateCredentials", () => {
  const expectedUser = "admin";
  const expectedPass = "admin";

  it("returns true for correct credentials", () => {
    expect(
      validateCredentials(expectedUser, expectedPass, "admin", "admin"),
    ).toBe(true);
  });

  it("returns false for wrong username", () => {
    expect(
      validateCredentials(expectedUser, expectedPass, "wrong", "admin"),
    ).toBe(false);
  });

  it("returns false for wrong password", () => {
    expect(
      validateCredentials(expectedUser, expectedPass, "admin", "wrong"),
    ).toBe(false);
  });

  it("returns false for empty credentials", () => {
    expect(validateCredentials(expectedUser, expectedPass, "", "")).toBe(false);
  });

  it("rejects when expected username differs", () => {
    expect(
      validateCredentials("other-user", expectedPass, "admin", "admin"),
    ).toBe(false);
  });
});

// ─── Session Token ────────────────────────────────────────────

describe("generateSessionToken / getSession", () => {
  it("generates a master token (no sessionId) with embedded expiry", () => {
    const token = generateSessionToken("admin");
    // Format: <base36_expiry>..<64_hex_chars>    (empty sessionId part)
    expect(token).toMatch(/^[0-9a-z]+\.[0-9a-f]{0,64}\.[0-9a-f]{64}$/);
    expect(getSessionIdFromToken(token)).toBeUndefined();
    // Decode the embedded expiry
    const dot = token.indexOf(".");
    const expiresAt = Number.parseInt(token.slice(0, dot), 36);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("generates a session-specific token with sessionId", () => {
    const token = generateSessionToken("admin", "pw__my-app__main");
    // Format: <base36_expiry>.<sessionId>.<random>
    expect(token).toMatch(/^[0-9a-z]+\.pw__my-app__main\.[0-9a-f]{64}$/);
    expect(getSessionIdFromToken(token)).toBe("pw__my-app__main");
  });

  it("getSession returns session for valid master token", () => {
    const token = generateSessionToken("admin");
    const session = getSession(token);
    expect(session).toBeDefined();
    expect(session?.username).toBe("admin");
    expect(session?.sessionId).toBeUndefined();
    expect(session?.createdAt).toBeLessThanOrEqual(Date.now());
    expect(session?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("getSession returns session with sessionId for session token", () => {
    const token = generateSessionToken("admin", "pw__test__main");
    const session = getSession(token);
    expect(session).toBeDefined();
    expect(session?.username).toBe("admin");
    expect(session?.sessionId).toBe("pw__test__main");
  });

  it("getSession returns undefined for unknown token", () => {
    expect(getSession("unknown-token")).toBeUndefined();
  });

  it("getSession returns undefined for expired embedded expiry", () => {
    // Construct a token with an already-expired timestamp
    const expiredTs = Date.now() - 1000;
    const token = `${expiredTs.toString(36)}..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(getSession(token)).toBeUndefined();
  });

  it("destroySession removes from in-memory Map", () => {
    const token = generateSessionToken("admin");
    // Verify it's in the Map
    expect(getSession(token)).toBeDefined();
    // Destroy it
    destroySession(token);
    // getSession checks Map — returns undefined
    expect(getSession(token)).toBeUndefined();
    // verifyWsToken is stateless — still returns true (not expired)
    expect(verifyWsToken(token)).toBe(true);
  });
});

describe("verifyWsToken", () => {
  it("returns true for valid session token", () => {
    const token = generateSessionToken("admin");
    expect(verifyWsToken(token)).toBe(true);
  });

  it("returns false for invalid token", () => {
    expect(verifyWsToken("invalid")).toBe(false);
  });

  it("returns false for expired embedded expiry", () => {
    // Token with a timestamp 1ms in the past
    const expiredTs = Date.now() - 1;
    const token = `${expiredTs.toString(36)}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(verifyWsToken(token)).toBe(false);
  });
});

// ─── getSessionIdFromToken ─────────────────────────────────────

describe("getSessionIdFromToken", () => {
  it("returns sessionId from session-specific token", () => {
    const token = generateSessionToken("admin", "pw__my-app__main");
    expect(getSessionIdFromToken(token)).toBe("pw__my-app__main");
  });

  it("returns undefined for master token (no sessionId)", () => {
    const token = generateSessionToken("admin");
    expect(getSessionIdFromToken(token)).toBeUndefined();
  });

  it("returns undefined for invalid token", () => {
    expect(getSessionIdFromToken("invalid")).toBeUndefined();
  });

  it("returns undefined for old-format token (no sessionId part)", () => {
    // Simulate old format: <exp>.<random> only 2 parts
    const expiredTs = Date.now() + 86400000;
    const token = `${expiredTs.toString(36)}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(getSessionIdFromToken(token)).toBeUndefined();
  });
});

// ─── Bearer Token ─────────────────────────────────────────────

describe("getBearerToken", () => {
  it("extracts token from Bearer header", () => {
    expect(getBearerToken("Bearer my-token")).toBe("my-token");
  });

  it("returns undefined for non-Bearer header", () => {
    expect(getBearerToken("Basic xxx")).toBeUndefined();
  });

  it("returns undefined for empty header", () => {
    expect(getBearerToken("")).toBeUndefined();
  });

  it("returns undefined for missing header", () => {
    expect(getBearerToken(undefined)).toBeUndefined();
  });
});

// ─── WebSocket Auth Message ───────────────────────────────────

describe("authenticateWsMessage", () => {
  it("accepts valid auth message", () => {
    const result = authenticateWsMessage({ type: "auth", token: "abc" });
    expect(result).toBe(true);
  });

  it("rejects message without token", () => {
    const result = authenticateWsMessage({ type: "auth" });
    expect(result).toBe(false);
  });

  it("rejects non-object", () => {
    expect(authenticateWsMessage("string")).toBe(false);
    expect(authenticateWsMessage(null)).toBe(false);
    expect(authenticateWsMessage(undefined)).toBe(false);
  });

  it("rejects wrong type", () => {
    expect(authenticateWsMessage({ type: "ping", token: "abc" })).toBe(false);
  });
});

// ─── Auth Challenge (Ed25519) ─────────────────────────────────

describe("generateAuthChallenge", () => {
  it("returns an object with timestamp and sessionId", () => {
    const challenge = generateAuthChallenge("test-session");
    expect(challenge).toHaveProperty("timestamp");
    expect(challenge).toHaveProperty("sessionId", "test-session");
    expect(typeof challenge.timestamp).toBe("number");
  });

  it("uses current time for timestamp", () => {
    const before = Date.now();
    const challenge = generateAuthChallenge("s");
    const after = Date.now();
    expect(challenge.timestamp).toBeGreaterThanOrEqual(before);
    expect(challenge.timestamp).toBeLessThanOrEqual(after);
  });
});

// ─── Ed25519 Signatures ───────────────────────────────────────

describe("verifySignature", () => {
  it("verifies a valid Ed25519 signature", () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const message = JSON.stringify({ ts: Date.now(), session: "test" });
    const sig = signMessage(privateKey, message);
    const result = verifySignature(publicKey, message, sig);
    expect(result).toBe(true);
  });

  it("rejects signature for wrong message", () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const message = JSON.stringify({ ts: Date.now(), session: "test" });
    const sig = signMessage(privateKey, message);
    const result = verifySignature(publicKey, "different-message", sig);
    expect(result).toBe(false);
  });

  it("rejects invalid signature format", () => {
    const result = verifySignature(
      Buffer.from("fake-key").toString("base64"),
      "message",
      "not-a-valid-signature",
    );
    expect(result).toBe(false);
  });

  it("accepts base64-encoded public key", () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const msg = JSON.stringify({ ts: Date.now(), session: "test" });
    const sig = signMessage(privateKey, msg);
    const result = verifySignature(publicKey, msg, sig);
    expect(result).toBe(true);
  });
});

// ─── Auth Middleware ───────────────────────────────────────────

describe("createAuthMiddleware", () => {
  let sessionToken: string;

  beforeEach(() => {
    resetConfig();
    loadConfig({ username: "admin", password: "admin" });
    sessionToken = generateSessionToken("admin");
  });

  it("accepts valid session token in Authorization header", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: { authorization: `Bearer ${sessionToken}` },
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(true);
  });

  it("rejects invalid token in Authorization header", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: { authorization: "Bearer invalid-session-token" },
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(false);
  });

  it("rejects request without any auth", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: {},
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(false);
  });

  it("rejects request with malformed Authorization header", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: { authorization: "Basic xyz" },
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(false);
  });

  it("accepts valid Ed25519 signature via query params", async () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    // Re-create middleware with the test public key
    const middleware = createAuthMiddleware({ publicKey });
    const msg = JSON.stringify({ ts: Date.now(), session: "test" });
    const sig = signMessage(privateKey, msg);
    const req = {
      headers: {},
      query: { sig, msg },
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(true);
  });

  it("rejects expired session token by embedded expiry", async () => {
    // Construct a token with expired embedded timestamp
    const expiredTs = Date.now() - 1000;
    const expiresAt = expiredTs.toString(36);
    const expiredToken = `${expiresAt}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const middleware = createAuthMiddleware();
    const req = {
      headers: { authorization: `Bearer ${expiredToken}` },
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(false);
  });
});

// ─── Config Security ──────────────────────────────────────────

describe("isStrongPassword", () => {
  it("accepts long passwords", () => {
    expect(isStrongPassword("my-secure-pass")).toBe(true);
  });

  it("rejects short passwords", () => {
    expect(isStrongPassword("abcd")).toBe(false);
  });

  it("rejects common weak passwords", () => {
    expect(isStrongPassword("admin")).toBe(false);
    expect(isStrongPassword("password")).toBe(false);
    expect(isStrongPassword("12345678")).toBe(false);
  });

  it("rejects repeated character passwords", () => {
    expect(isStrongPassword("aaaaaaaa")).toBe(false);
    expect(isStrongPassword("11111111")).toBe(false);
  });

  it("accepts edge-case 8-char password", () => {
    expect(isStrongPassword("Abcd1234")).toBe(true);
  });
});

// ─── Helpers ──────────────────────────────────────────────────

function generateTestKeyPair(): {
  publicKey: string;
  privateKey: Buffer;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: Buffer.from(publicKey).toString("base64"),
    privateKey: Buffer.from(privateKey),
  };
}

function signMessage(privateKey: Buffer, message: string): string {
  const key = crypto.createPrivateKey({
    key: privateKey,
    type: "pkcs8",
    format: "der",
  });
  const sig = crypto.sign(null, Buffer.from(message), key);
  return Buffer.from(sig).toString("base64");
}
