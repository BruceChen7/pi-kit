import { describe, expect, it, vi } from "vitest";
import {
  detectSessionStatus,
  getTmuxSessionName,
  parseTmuxSessionName,
} from "../sessions.js";

// ─── Naming ───────────────────────────────────────────────────

describe("getTmuxSessionName", () => {
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

describe("parseTmuxSessionName", () => {
  it("parses standard name", () => {
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

  it("roundtrips: getTmuxSessionName → parseTmuxSessionName", () => {
    const name = getTmuxSessionName("my-project", "feature/auth");
    const parsed = parseTmuxSessionName(name);
    expect(parsed).toEqual({
      dirname: "my-project",
      branch: "feature_auth", // '/' sanitized to '_'
    });
  });
});

// ─── Status Detection (without tmux) ──────────────────────────

describe("detectSessionStatus", () => {
  it("returns stopped for empty or absent session", () => {
    expect(detectSessionStatus("")).toBe("stopped");
  });
});
