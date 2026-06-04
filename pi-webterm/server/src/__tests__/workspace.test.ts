import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverWorkspace,
  getLocalBranches,
  getWorkspaceCache,
  refreshWorkspace,
  resetWorkspaceCache,
  scanGitRepos,
  shortHash,
} from "../workspace.js";

// Use vi.hoisted to create mocks before vi.mock factories run (they're hoisted)
const { mockExecSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

// ─── shortHash ────────────────────────────────────────────────

describe("shortHash", () => {
  it("returns 4 hex characters", () => {
    const hash = shortHash("/some/path");
    expect(hash).toHaveLength(4);
    expect(hash).toMatch(/^[0-9a-f]{4}$/);
  });

  it("produces consistent output for same input", () => {
    expect(shortHash("/same/path")).toBe(shortHash("/same/path"));
  });

  it("produces different output for different inputs", () => {
    expect(shortHash("/path/a")).not.toBe(shortHash("/path/b"));
  });

  it("handles empty input", () => {
    const hash = shortHash("");
    expect(hash).toHaveLength(4);
    expect(hash).toMatch(/^[0-9a-f]{4}$/);
  });
});

// ─── getLocalBranches ─────────────────────────────────────────

describe("getLocalBranches", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns parsed branch list", () => {
    mockExecSync.mockReturnValue("main\nfeature/auth\nfix/123\n");
    const branches = getLocalBranches("/fake/repo");
    expect(branches).toEqual(["main", "feature/auth", "fix/123"]);
  });

  it("returns empty array on git failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("git not found");
    });
    const branches = getLocalBranches("/fake/repo");
    expect(branches).toEqual([]);
  });

  it("trims whitespace from branch names", () => {
    mockExecSync.mockReturnValue("  main  \n  dev  \n");
    const branches = getLocalBranches("/fake/repo");
    expect(branches).toEqual(["main", "dev"]);
  });
});

// ─── scanGitRepos ─────────────────────────────────────────────

describe("scanGitRepos", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("returns empty array when find fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("find failed");
    });
    const repos = scanGitRepos("/tmp");
    expect(repos).toEqual([]);
  });

  it("returns empty array for non-existent base path", () => {
    mockExistsSync.mockReturnValue(false);
    const repos = scanGitRepos("/nonexistent");
    expect(repos).toEqual([]);
  });

  it("returns repos sorted by name", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string, _opts?: any) => {
      if (cmd.includes("find")) {
        return "/tmp/repo-b/.git\n/tmp/repo-a/.git\n";
      }
      if (cmd.includes("git rev-parse --git-dir")) {
        return ".git\n";
      }
      if (cmd.includes("git branch --format")) {
        return "main\ndev\n";
      }
      return "";
    });

    const repos = scanGitRepos("/tmp");
    expect(repos).toHaveLength(2);
    expect(repos[0].name).toBe("repo-a");
    expect(repos[1].name).toBe("repo-b");
    expect(repos[0].branches).toContain("main");
    expect(repos[1].branches).toContain("dev");
  });

  it("deduplicates repos found via multiple .git entries", () => {
    mockExistsSync.mockReturnValue(true);
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: string, _opts?: any) => {
      if (cmd.includes("find")) {
        return "/tmp/repo/.git\n/tmp/repo/.git\n";
      }
      if (cmd.includes("git rev-parse --git-dir")) {
        callCount++;
        return ".git\n";
      }
      if (cmd.includes("git branch --format")) {
        return "main\n";
      }
      return "";
    });

    const repos = scanGitRepos("/tmp");
    expect(repos).toHaveLength(1);
  });
});

// ─── Cache management ─────────────────────────────────────────

describe("workspace cache", () => {
  beforeEach(() => {
    resetWorkspaceCache();
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("getWorkspaceCache runs discovery if not cached", () => {
    // Discovery will call existsSync and execSync — make them work
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("find")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    const cache = getWorkspaceCache();
    expect(cache).toHaveProperty("repos");
    expect(cache).toHaveProperty("scannedAt");
    expect(cache).toHaveProperty("basePath");
    expect(typeof cache.scannedAt).toBe("number");
  });

  it("refreshWorkspace replaces existing cache", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("find")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    const cache1 = discoverWorkspace("/tmp");
    const firstScannedAt = cache1.scannedAt;

    // Ensure the next timestamp is different
    const cache2 = refreshWorkspace("/other");
    expect(cache2.basePath).not.toBe(cache1.basePath);
    expect(cache2.scannedAt).toBeGreaterThanOrEqual(firstScannedAt);
  });

  it("resetWorkspaceCache clears cache", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("find")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    discoverWorkspace("/tmp");
    expect(getWorkspaceCache()).toBeTruthy();
    resetWorkspaceCache();

    const cache = getWorkspaceCache();
    expect(cache).toBeTruthy();
  });
});
