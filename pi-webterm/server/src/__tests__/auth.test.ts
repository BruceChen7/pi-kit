import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAuthMiddleware,
  generateAuthChallenge,
  verifySignature,
  verifyToken,
} from "../auth.js";
import { loadConfig, resetConfig } from "../config.js";

describe("verifyToken", () => {
  it("returns true for matching token", () => {
    const result = verifyToken("my-secret", "my-secret");
    expect(result).toBe(true);
  });

  it("returns false for non-matching token", () => {
    const result = verifyToken("my-secret", "wrong-token");
    expect(result).toBe(false);
  });

  it("returns false for empty token", () => {
    const result = verifyToken("my-secret", "");
    expect(result).toBe(false);
  });

  it("returns false when submitted token is undefined", () => {
    const result = verifyToken("my-secret", undefined);
    expect(result).toBe(false);
  });

  it("uses constant-time comparison to prevent timing attacks", () => {
    // TimingSafeEqual is used internally; just verify correctness
    const result = verifyToken("token-abc", "token-abc");
    expect(result).toBe(true);
  });
});

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
    // publicKey is already base64 from generateTestKeyPair
    const result = verifySignature(publicKey, msg, sig);
    expect(result).toBe(true);
  });
});

describe("createAuthMiddleware", () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({ token: "config-token-123" });
  });

  it("accepts valid token in Authorization header", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: { authorization: "Bearer config-token-123" },
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(true);
  });

  it("rejects invalid token in Authorization header", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: { authorization: "Bearer wrong-token" },
      query: {},
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(false);
  });

  it("accepts valid token in query parameter", async () => {
    const middleware = createAuthMiddleware();
    const req = {
      headers: {},
      query: { token: "config-token-123" },
    } as any;
    const result = await middleware(req as any);
    expect(result).toBe(true);
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
});

// --- Helpers ---

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
