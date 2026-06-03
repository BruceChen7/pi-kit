import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBindAuthConfig,
  getConfig,
  isLoopbackHost,
  isNetworkHost,
  isStrongPassword,
  loadConfig,
  resetConfig,
} from "../config.js";

let tempDataDir: string;

beforeAll(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), "pi-webterm-test-"));
  // env("dataDir") looks up PI_WEBTERM_DATADIR (key.toUpperCase() with prefix)
  process.env.PI_WEBTERM_DATADIR = tempDataDir;
});

afterAll(() => {
  delete process.env.PI_WEBTERM_DATADIR;
  rmSync(tempDataDir, { recursive: true, force: true });
});

afterEach(() => {
  resetConfig();
  delete process.env.PI_WEBTERM_PORT;
  delete process.env.PI_WEBTERM_HOST;
  delete process.env.PI_WEBTERM_USERNAME;
  delete process.env.PI_WEBTERM_PASSWORD;
  delete process.env.PI_WEBTERM_CWD;
  delete process.env.PI_WEBTERM_AGENT;
});

describe("loadConfig", () => {
  it("returns defaults when no env/args set", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(4730);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.agentCommand).toBe("pi");
    expect(cfg.autoStartAgent).toBe(true);
    // dataDir comes from PI_WEBTERM_DATA_DIR env (set to temp dir in beforeAll)
    expect(cfg.dataDir).toBe(tempDataDir);
    expect(cfg.username).toBe("admin");
    expect(cfg.password).toBe("admin");
    expect(cfg.authRequired).toBe(true);
  });

  it("reads port from env PI_WEBTERM_PORT", () => {
    process.env.PI_WEBTERM_PORT = "8080";
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8080);
  });

  it("reads port from CLI args (higher priority than env)", () => {
    process.env.PI_WEBTERM_PORT = "3000";
    const cfg = loadConfig({ port: 9090 });
    expect(cfg.port).toBe(9090);
  });

  it("reads host from env PI_WEBTERM_HOST", () => {
    process.env.PI_WEBTERM_HOST = "127.0.0.1";
    const cfg = loadConfig({});
    expect(cfg.host).toBe("127.0.0.1");
  });

  it("reads username and password from env", () => {
    process.env.PI_WEBTERM_USERNAME = "myuser";
    process.env.PI_WEBTERM_PASSWORD = "my-secure-pass";
    const cfg = loadConfig({});
    expect(cfg.username).toBe("myuser");
    expect(cfg.password).toBe("my-secure-pass");
  });

  it("reads username and password from CLI args (higher priority)", () => {
    process.env.PI_WEBTERM_USERNAME = "env-user";
    const cfg = loadConfig({ username: "cli-user", password: "cli-pass" });
    expect(cfg.username).toBe("cli-user");
    expect(cfg.password).toBe("cli-pass");
  });

  it("generates tmuxSessionName from cwd basename", () => {
    const cfg = loadConfig({ cwd: "/Users/test/work/my-project" });
    expect(cfg.tmuxSessionName).toBe("pw_my-project");
    expect(cfg.cwd).toBe("/Users/test/work/my-project");
  });

  it("allows overriding tmuxSessionName explicitly", () => {
    const cfg = loadConfig({
      cwd: "/Users/test/work/my-project",
      tmuxSessionName: "custom-session",
    });
    expect(cfg.tmuxSessionName).toBe("custom-session");
  });

  it("auto-generates Ed25519 key pair", () => {
    const cfg = loadConfig({});
    expect(cfg.publicKey).toBeTruthy();
    expect(cfg.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("agentCommand overridable via env PI_WEBTERM_AGENT", () => {
    process.env.PI_WEBTERM_AGENT = "claude";
    const cfg = loadConfig({});
    expect(cfg.agentCommand).toBe("claude");
  });
});

describe("getConfig", () => {
  it("returns cached config after loadConfig", () => {
    loadConfig({ port: 5555 });
    expect(getConfig().port).toBe(5555);
  });

  it("throws if called before loadConfig", () => {
    expect(() => getConfig()).toThrow("Config not loaded");
  });
});

// ─── Security ─────────────────────────────────────────────────

describe("isStrongPassword", () => {
  it("accepts long passwords", () => {
    expect(isStrongPassword("my-secure-pass")).toBe(true);
  });

  it("accepts 8-character non-trivial password", () => {
    expect(isStrongPassword("Abcd1234")).toBe(true);
  });

  it("rejects short passwords (< 8 chars)", () => {
    expect(isStrongPassword("abcd")).toBe(false);
    expect(isStrongPassword("1234567")).toBe(false);
  });

  it("rejects common weak passwords", () => {
    expect(isStrongPassword("admin")).toBe(false);
    expect(isStrongPassword("password")).toBe(false);
    expect(isStrongPassword("12345678")).toBe(false);
    expect(isStrongPassword("password123")).toBe(false);
  });

  it("rejects repeated character passwords", () => {
    expect(isStrongPassword("aaaaaaaa")).toBe(false);
    expect(isStrongPassword("11111111")).toBe(false);
  });

  it("rejects case-insensitive weak passwords", () => {
    // The check uses .toLowerCase() so ADMIN should also be rejected
    expect(isStrongPassword("ADMIN")).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("identifies localhost as loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("identifies 127.0.0.1 as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("identifies ::1 as loopback", () => {
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("identifies 0.0.0.0 as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("isNetworkHost", () => {
  it("identifies 0.0.0.0 as network", () => {
    expect(isNetworkHost("0.0.0.0")).toBe(true);
  });

  it("identifies localhost as non-network", () => {
    expect(isNetworkHost("localhost")).toBe(false);
  });

  it("identifies 127.0.0.1 as non-network", () => {
    expect(isNetworkHost("127.0.0.1")).toBe(false);
  });

  it("identifies empty string as network (default bind)", () => {
    expect(isNetworkHost("")).toBe(true);
  });
});

describe("assertSafeBindAuthConfig", () => {
  it("allows loopback with weak password", () => {
    expect(() => assertSafeBindAuthConfig("127.0.0.1", "admin")).not.toThrow();
  });

  it("throws for 0.0.0.0 with weak password", () => {
    expect(() => assertSafeBindAuthConfig("0.0.0.0", "admin")).toThrow(
      "Unsafe configuration",
    );
  });

  it("allows 0.0.0.0 with strong password", () => {
    expect(() =>
      assertSafeBindAuthConfig("0.0.0.0", "my-strong-password"),
    ).not.toThrow();
  });

  it("throws for 0.0.0.0 with short password", () => {
    expect(() => assertSafeBindAuthConfig("0.0.0.0", "abc")).toThrow(
      "Unsafe configuration",
    );
  });
});
