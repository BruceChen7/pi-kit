import { describe, expect, it, vi } from "vitest";
import {
  detectSessionStatus,
  getTmuxSessionName,
  parseTmuxSessionName,
} from "../sessions.js";

// Mock workspace module for shortHash
vi.mock("../workspace.js", () => ({
  shortHash: vi.fn((s: string) => {
    // Deterministic mock: return first 4 chars of input reversed
    return s.split("").reverse().join("").slice(0, 4) || "0000";
  }),
}));

// ─── Naming (v1 — without cwd) ────────────────────────────────

describe("getTmuxSessionName (v1, no cwd)", () => {
  it("builds name from dirname and branch", () => {
    expect(getTmuxSessionName("my-app", "main")).toBe("pw__my-app__main");
  });

  it("sanitizes special characters in dirname", () => {
    expect(getTmuxSessionName("my app:test", "main")).toBe(
      "pw__my_app_test__main",
    );
  });

  it("sanitizes special characters in branch", () => {
    expect(getTmuxSessionName("my-app", "feature/my-feature")).toBe(
      "pw__my-app__feature_my-feature",
    );
  });

  it("handles branch with dots", () => {
    expect(getTmuxSessionName("project", "v1.2.3")).toBe("pw__project__v1.2.3");
  });

  it("handles branch with underscores (non-separator)", () => {
    expect(getTmuxSessionName("app", "my_branch")).toBe("pw__app__my_branch");
  });

  it("handles empty dirname gracefully (falls back to 'root')", () => {
    const name = getTmuxSessionName("", "main");
    expect(name).toMatch(/^pw__root__main$/);
  });

  it("handles empty branch gracefully (falls back to 'main')", () => {
    const name = getTmuxSessionName("my-app", "");
    expect(name).toMatch(/^pw__my-app__main$/);
  });
});

// ─── Naming (v2 — with cwd / hash) ────────────────────────────

describe("getTmuxSessionName (v2, with cwd)", () => {
  it("appends short hash when cwd is provided", () => {
    const name = getTmuxSessionName("my-app", "main", "/path/to/repo");
    // Mock shortHash("/path/to/repo") → reversed + slice(0,4) = "oper"
    expect(name).toBe("pw__my-app__main__oper");
  });

  it("produces different hashes for different cwds", () => {
    const name1 = getTmuxSessionName("my-app", "main", "/path/a");
    const name2 = getTmuxSessionName("my-app", "main", "/path/b");
    expect(name1).not.toBe(name2);
  });

  it("same dirname+branch with same cwd produces same name", () => {
    const name1 = getTmuxSessionName("app", "dev", "/project");
    const name2 = getTmuxSessionName("app", "dev", "/project");
    expect(name1).toBe(name2);
  });
});

// ─── Parsing (v1 — old format) ────────────────────────────────

describe("parseTmuxSessionName (v1)", () => {
  it("parses standard v1 name without hash", () => {
    const result = parseTmuxSessionName("pw__my-app__main");
    expect(result).toEqual({ dirname: "my-app", branch: "main" });
  });

  it("parses name with dots in branch", () => {
    const result = parseTmuxSessionName("pw__project__v1.2.3");
    expect(result).toEqual({ dirname: "project", branch: "v1.2.3" });
  });

  it("parses name with sanitized branch (slashes → underscores)", () => {
    const result = parseTmuxSessionName("pw__my-app__feature_my-feature");
    expect(result).toEqual({
      dirname: "my-app",
      branch: "feature_my-feature",
    });
  });

  it("parses name with dirname containing underscores", () => {
    const result = parseTmuxSessionName("pw__node_fs__main");
    expect(result).toEqual({ dirname: "node_fs", branch: "main" });
  });

  it("returns null for non-pw prefix", () => {
    expect(parseTmuxSessionName("other-session")).toBeNull();
  });

  it("returns null for malformed name without __ separator", () => {
    expect(parseTmuxSessionName("pw__onlydir")).toBeNull();
  });

  it("returns null for empty dirname", () => {
    expect(parseTmuxSessionName("pw____main")).toBeNull();
  });
});

// ─── Parsing (v2 — new format with hash) ──────────────────────

describe("parseTmuxSessionName (v2)", () => {
  it("parses v2 name with hash", () => {
    const result = parseTmuxSessionName("pw__my-app__main__a3f2");
    expect(result).toEqual({
      dirname: "my-app",
      branch: "main",
      hash: "a3f2",
    });
  });

  it("parses v2 name with underscores in dirname", () => {
    const result = parseTmuxSessionName("pw__node_fs__main__b1c2");
    expect(result).toEqual({
      dirname: "node_fs",
      branch: "main",
      hash: "b1c2",
    });
  });

  it("parses v2 name with sanitized branch", () => {
    const result = parseTmuxSessionName("pw__my-app__feature_auth__x7y8");
    expect(result).toEqual({
      dirname: "my-app",
      branch: "feature_auth",
      hash: "x7y8",
    });
  });
});

// ─── Roundtrip ────────────────────────────────────────────────

describe("roundtrip", () => {
  it("v1: getTmuxSessionName → parseTmuxSessionName", () => {
    const name = getTmuxSessionName("my-project", "feature/auth");
    const parsed = parseTmuxSessionName(name);
    expect(parsed).toEqual({
      dirname: "my-project",
      branch: "feature_auth", // '/' sanitized to '_'
    });
    // v1 without cwd should not have hash
    expect(parsed).not.toHaveProperty("hash");
  });

  it("v2: getTmuxSessionName with cwd → parseTmuxSessionName", () => {
    const name = getTmuxSessionName("my-project", "feature/auth", "/my/path");
    const parsed = parseTmuxSessionName(name);
    expect(parsed).toEqual({
      dirname: "my-project",
      branch: "feature_auth",
      hash: expect.any(String),
    });
  });
});

// ─── Status Detection (without tmux) ──────────────────────────

describe("detectSessionStatus", () => {
  it("returns stopped for empty or absent session", () => {
    expect(detectSessionStatus("")).toBe("stopped");
  });
});
