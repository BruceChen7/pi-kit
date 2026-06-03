import { afterEach, describe, expect, it } from "vitest";
import { getConfig, loadConfig, resetConfig } from "../config.js";

afterEach(() => {
  resetConfig();
  delete process.env.PI_WEBTERM_PORT;
  delete process.env.PI_WEBTERM_HOST;
  delete process.env.PI_WEBTERM_TOKEN;
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
    expect(cfg.dataDir).toContain(".pi/pi-webterm");
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

  it("reads token from env PI_WEBTERM_TOKEN", () => {
    process.env.PI_WEBTERM_TOKEN = "my-token";
    const cfg = loadConfig({});
    expect(cfg.token).toBe("my-token");
  });

  it("generates tmuxSessionName from cwd basename", () => {
    const cfg = loadConfig({ cwd: "/Users/test/work/my-project" });
    expect(cfg.tmuxSessionName).toBe("pw:my-project");
    expect(cfg.cwd).toBe("/Users/test/work/my-project");
  });

  it("allows overriding tmuxSessionName explicitly", () => {
    const cfg = loadConfig({
      cwd: "/Users/test/work/my-project",
      tmuxSessionName: "custom-session",
    });
    expect(cfg.tmuxSessionName).toBe("custom-session");
  });

  it("auto-generates token if not provided", () => {
    const cfg = loadConfig({});
    expect(cfg.token).toBeTruthy();
    expect(cfg.token.length).toBeGreaterThan(16);
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
