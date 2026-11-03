import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authCookieHeader,
  clearAuthRecord,
  parseAuthRecord,
  parseSessionCookie,
  readAuthRecord,
  resolvePassword,
  signIn,
  writeAuthRecord,
} from "./auth.js";
import type { DoopConfig } from "./config.js";

const tempDirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doop-auth-"));
  tempDirs.push(dir);
  return path.join(dir, "doop-auth.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

const config: DoopConfig = {
  baseUrl: "http://127.0.0.1:4300",
  agentKey: "dpk_test",
  agentName: "pi",
  watch: false,
  cards: false,
};

const RECORD = {
  email: "rich@example.com",
  cookie: "better-auth.session_token=abc.def",
  obtainedAt: 1,
};

describe("parseSessionCookie", () => {
  it("keeps the session cookie and drops its attributes", () => {
    expect(
      parseSessionCookie([
        "better-auth.session_token=abc.def; Path=/; HttpOnly; SameSite=Lax",
      ]),
    ).toBe("better-auth.session_token=abc.def");
  });

  it("keeps the __Secure- prefix an https instance sets", () => {
    expect(
      parseSessionCookie([
        "__Secure-better-auth.session_token=abc.def; Path=/; HttpOnly; Secure",
      ]),
    ).toBe("__Secure-better-auth.session_token=abc.def");
  });

  it("skips other cookies", () => {
    expect(
      parseSessionCookie([
        "theme=dark; Path=/",
        "better-auth.session_token=xyz",
      ]),
    ).toBe("better-auth.session_token=xyz");
  });

  it("returns undefined when nothing matches or the value is empty", () => {
    expect(parseSessionCookie([])).toBeUndefined();
    expect(parseSessionCookie(["other=1"])).toBeUndefined();
    expect(
      parseSessionCookie(["better-auth.session_token=; Path=/"]),
    ).toBeUndefined();
  });
});

describe("parseAuthRecord", () => {
  it("accepts a stored record", () => {
    expect(parseAuthRecord(RECORD, "file")).toEqual(RECORD);
  });

  it("rejects a record without a cookie and names the fix", () => {
    const parsed = parseAuthRecord({ email: "a@b" }, "file");
    expect(parsed).toMatchObject({ kind: "invalid" });
    if (!("kind" in parsed)) return;
    expect(parsed.message).toContain("/doop login");
  });

  it("accepts a __Secure- session cookie and echoes its name", () => {
    const parsed = parseAuthRecord(
      {
        email: "a@b",
        cookie: "__Secure-better-auth.session_token=abc.def",
        obtainedAt: 1,
      },
      "file",
    );
    if ("kind" in parsed) throw new Error("unexpected");
    expect(authCookieHeader(parsed)).toBe(
      "__Secure-better-auth.session_token=abc.def",
    );
  });

  it("rejects a cookie that is not the session cookie", () => {
    const parsed = parseAuthRecord(
      { email: "a@b", cookie: "theme=dark" },
      "file",
    );
    expect(parsed).toMatchObject({ kind: "invalid" });
  });

  it("rejects a non-object", () => {
    expect(parseAuthRecord("nope", "file")).toMatchObject({ kind: "invalid" });
  });

  it("builds the Cookie header verbatim", () => {
    const parsed = parseAuthRecord(RECORD, "file");
    if ("kind" in parsed) throw new Error("unexpected");
    expect(authCookieHeader(parsed)).toBe(RECORD.cookie);
  });
});

describe("auth file", () => {
  it("reads back what it wrote, at 0600", () => {
    const file = tempFile();
    writeAuthRecord(file, RECORD);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const loaded = readAuthRecord(file);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.email).toBe(RECORD.email);
  });

  it("converges an existing 0644 file to 0600", () => {
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify(RECORD));
    fs.chmodSync(file, 0o644);
    writeAuthRecord(file, RECORD);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reports a missing file as 'not signed in'", () => {
    const loaded = readAuthRecord(path.join(tempFile(), "missing.json"));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe("missing");
    expect(loaded.error.message).toContain("/doop login");
  });

  it("reports invalid JSON without throwing", () => {
    const file = tempFile();
    fs.writeFileSync(file, "{nope");
    const loaded = readAuthRecord(file);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe("invalid");
  });

  it("logout removes the file and stays idempotent", () => {
    const file = tempFile();
    writeAuthRecord(file, RECORD);
    clearAuthRecord(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => clearAuthRecord(file)).not.toThrow();
  });
});

describe("resolvePassword", () => {
  it("prefers DOOP_PASSWORD", () => {
    expect(
      resolvePassword("anyone@example.com", { DOOP_PASSWORD: "s3cret" }),
    ).toBe("s3cret");
  });

  it("returns undefined when the env is empty and nothing is in the keychain", () => {
    expect(
      resolvePassword("definitely-not-a-key@example.com", {}),
    ).toBeUndefined();
  });
});

describe("signIn", () => {
  it("keeps the session cookie from set-cookie", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "set-cookie": "better-auth.session_token=abc.def; Path=/; HttpOnly",
          },
        }),
    );
    const result = await signIn(
      config,
      { email: "rich@example.com", password: "pw" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.cookie).toBe("better-auth.session_token=abc.def");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:4300/api/auth/sign-in/email");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "rich@example.com",
      password: "pw",
    });
    /* better-auth answers MISSING_OR_NULL_ORIGIN without it */
    expect((init.headers as Record<string, string>).origin).toBe(
      "http://127.0.0.1:4300",
    );
  });

  it("maps 401 to a credentials message", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const result = await signIn(
      config,
      { email: "a@b", password: "wrong" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("login");
    expect(result.error.message).toContain("email and password");
  });

  it("refuses a 200 that carried no session cookie", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await signIn(
      config,
      { email: "a@b", password: "pw" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("login");
    expect(result.error.message).toContain("no session cookie");
  });

  it("names the instance when it is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const result = await signIn(
      config,
      { email: "a@b", password: "pw" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unreachable");
    expect(result.error.message).toContain("http://127.0.0.1:4300");
  });
});
