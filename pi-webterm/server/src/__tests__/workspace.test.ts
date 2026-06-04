import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRepoDiff,
  discoverWorkspace,
  getCachePath,
  getLocalBranches,
  getWorkspaceCache,
  loadCacheFromDisk,
  parseGitEntries,
  refreshWorkspace,
  resetWorkspaceCache,
  saveCacheToDisk,
  scanGitRepos,
  shortHash,
  WorkspaceScanner,
} from "../workspace.js";
import type { GitRepo, WorkspaceCache } from "../workspace.js";

// Use vi.hoisted to create mocks before vi.mock factories run (they're hoisted)
const {
  mockExecSync,
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockMkdirSync,
  mockReaddirSync,
} = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReaddirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  readdirSync: mockReaddirSync,
}));

vi.mock("node:os", () => ({
  homedir: () => "/fake-home",
}));

// ─── Test helpers ──────────────────────────────────────────────

function resetAllMocks() {
  mockExecSync.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockMkdirSync.mockReset();
  mockReaddirSync.mockReset();
}

/** Return a mock impl that checks if a path is in the given set of existing paths. */
function hasDotGit(...paths: string[]) {
  const gitRoots = new Set(paths);
  return (p: string) => gitRoots.has(p);
}

// ─── Functional Core: parseGitEntries (pure) ──────────────────

describe("parseGitEntries", () => {
  it("returns empty array for empty string", () => {
    expect(parseGitEntries("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseGitEntries("  \n  \n")).toEqual([]);
  });

  it("extracts parent directory from a single .git entry", () => {
    const result = parseGitEntries("/tmp/my-repo/.git\n");
    expect(result).toEqual(["/tmp/my-repo"]);
  });

  it("returns sorted, deduplicated repo roots", () => {
    const output = [
      "/tmp/repo-b/.git",
      "/tmp/repo-a/.git",
      "/tmp/repo-b/.git", // duplicate
    ].join("\n");

    const result = parseGitEntries(output);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("/tmp/repo-a");
    expect(result[1]).toBe("/tmp/repo-b");
  });

  it("handles both file-type and directory-type .git entries", () => {
    const output = ["/tmp/worktree/.git", "/tmp/regular/.git"].join("\n");
    const result = parseGitEntries(output);
    // Both have parent dir extracted the same way
    expect(result).toContain("/tmp/worktree");
    expect(result).toContain("/tmp/regular");
  });

  it("trims whitespace from each line", () => {
    const output = "  /tmp/repo/.git  \n";
    const result = parseGitEntries(output);
    expect(result).toEqual(["/tmp/repo"]);
  });
});

// ─── Functional Core: computeRepoDiff (pure) ──────────────────

describe("computeRepoDiff", () => {
  const repoA: GitRepo = {
    path: "/tmp/repo-a",
    name: "repo-a",
    branches: ["main", "dev"],
  };
  const repoB: GitRepo = {
    path: "/tmp/repo-b",
    name: "repo-b",
    branches: ["feature/x"],
  };
  const repoC: GitRepo = {
    path: "/tmp/repo-c",
    name: "repo-c",
    branches: [],
  };

  it("keeps all repos when nothing changed", () => {
    const diff = computeRepoDiff(
      [repoA, repoB],
      new Set(["/tmp/repo-a", "/tmp/repo-b"]),
      new Set(["/tmp/repo-a", "/tmp/repo-b"]),
    );
    expect(diff.kept).toHaveLength(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.deleted).toHaveLength(0);
  });

  it("marks deleted repos when .git is gone", () => {
    const diff = computeRepoDiff(
      [repoA, repoB],
      new Set(["/tmp/repo-a"]), // repo-b .git removed
      new Set(["/tmp/repo-a", "/tmp/repo-b"]),
    );
    expect(diff.kept).toHaveLength(1);
    expect(diff.kept[0].path).toBe("/tmp/repo-a");
    expect(diff.deleted).toHaveLength(1);
    expect(diff.deleted[0].path).toBe("/tmp/repo-b");
    expect(diff.added).toHaveLength(0);
  });

  it("discovers new repos from directory listing", () => {
    const newDir = "/tmp/repo-c";
    const diff = computeRepoDiff(
      [repoA],
      new Set(["/tmp/repo-a", newDir]),
      new Set(["/tmp/repo-a", newDir]),
    );
    expect(diff.kept).toHaveLength(1);
    expect(diff.deleted).toHaveLength(0);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].path).toBe(newDir);
    expect(diff.added[0].name).toBe("repo-c");
    expect(diff.added[0].branches).toEqual([]); // lazy
  });

  it("handles simultaneous keep, delete, and add", () => {
    const diff = computeRepoDiff(
      [repoA, repoB],
      new Set(["/tmp/repo-a", "/tmp/repo-c"]), // repo-b deleted, repo-c new
      new Set(["/tmp/repo-a", "/tmp/repo-b", "/tmp/repo-c"]),
    );
    expect(diff.kept).toHaveLength(1);
    expect(diff.kept[0].path).toBe("/tmp/repo-a");
    expect(diff.deleted).toHaveLength(1);
    expect(diff.deleted[0].path).toBe("/tmp/repo-b");
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].path).toBe("/tmp/repo-c");
  });

  it("does not add repos that are already in kept", () => {
    const diff = computeRepoDiff(
      [repoA],
      new Set(["/tmp/repo-a"]),
      new Set(["/tmp/repo-a"]), // same path in dirs
    );
    expect(diff.added).toHaveLength(0);
  });

  it("does not add paths without .git even if in dir listing", () => {
    const diff = computeRepoDiff(
      [repoA],
      new Set(["/tmp/repo-a"]),
      new Set(["/tmp/repo-a", "/tmp/non-repo"]), // non-repo has no .git
    );
    expect(diff.kept).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
  });

  it("preserves branches from cache for kept repos", () => {
    const diff = computeRepoDiff(
      [repoA],
      new Set(["/tmp/repo-a"]),
      new Set(["/tmp/repo-a"]),
    );
    expect(diff.kept[0].branches).toEqual(["main", "dev"]);
  });
});

// ─── disk cache helpers ─────────────────────────────────────

describe("getCachePath", () => {
  it("returns path under controlled home directory", () => {
    expect(getCachePath()).toBe("/fake-home/.pi-webterm/workspace-cache.json");
  });
});

describe("saveCacheToDisk / loadCacheFromDisk", () => {
  const sampleCache: WorkspaceCache = {
    repos: [
      {
        path: "/tmp/repo-a",
        name: "repo-a",
        branches: ["main", "dev"],
      },
    ],
    scannedAt: 1000,
    basePath: "/tmp",
  };

  beforeEach(resetAllMocks);

  it("saveCacheToDisk writes JSON to cache file", () => {
    mockExistsSync.mockReturnValue(true); // cache dir exists
    saveCacheToDisk(sampleCache);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = mockWriteFileSync.mock.calls[0];
    expect(path).toBe("/fake-home/.pi-webterm/workspace-cache.json");
    expect(encoding).toBe("utf-8");

    // Verify JSON round-trips back to the same structure
    const parsed = JSON.parse(content as string);
    expect(parsed).toEqual(sampleCache);
  });

  it("saveCacheToDisk creates cache dir if missing", () => {
    mockExistsSync.mockReturnValue(false); // cache dir doesn't exist
    saveCacheToDisk(sampleCache);

    expect(mockMkdirSync).toHaveBeenCalledWith("/fake-home/.pi-webterm", {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("loadCacheFromDisk returns parsed cache when basePath matches", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleCache));
    const result = loadCacheFromDisk("/tmp");

    expect(result).toEqual(sampleCache);
  });

  it("loadCacheFromDisk returns null when basePath mismatches", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleCache));
    const result = loadCacheFromDisk("/different");

    expect(result).toBeNull();
  });

  it("loadCacheFromDisk returns null on file read error", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = loadCacheFromDisk("/tmp");
    expect(result).toBeNull();
  });

  it("loadCacheFromDisk returns null on invalid JSON", () => {
    mockReadFileSync.mockReturnValue("{invalid}");
    const result = loadCacheFromDisk("/tmp");
    expect(result).toBeNull();
  });

  it("loadCacheFromDisk returns null when repos is not an array", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ basePath: "/tmp", repos: null, scannedAt: 1 }),
    );
    const result = loadCacheFromDisk("/tmp");
    expect(result).toBeNull();
  });
});

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
  beforeEach(resetAllMocks);

  it.each([
    {
      desc: "fd command fails",
      arrange: () =>
        mockExecSync.mockImplementation(() => {
          throw new Error("fd failed");
        }),
    },
    {
      desc: "base path does not exist",
      arrange: () => mockExistsSync.mockReturnValue(false),
    },
  ])("returns empty array when $desc", ({ arrange }) => {
    arrange();
    expect(scanGitRepos("/tmp")).toEqual([]);
  });

  it("orchestrates fd + filesystem to produce repos with lazy branches", () => {
    mockExistsSync.mockImplementation(
      hasDotGit(
        "/tmp",
        "/tmp/repo-a",
        "/tmp/repo-b",
        "/tmp/repo-a/.git",
        "/tmp/repo-b/.git",
      ),
    );
    mockExecSync.mockImplementation((cmd: string) =>
      cmd.includes("fd") ? "/tmp/repo-b/.git\n/tmp/repo-a/.git\n" : "",
    );

    const repos = scanGitRepos("/tmp");

    expect(repos).toHaveLength(2);
    expect(repos[0].name).toBe("repo-a");
    expect(repos[1].name).toBe("repo-b");
    // Branches are lazy — always empty from scanGitRepos
    expect(repos[0].branches).toEqual([]);
    expect(repos[1].branches).toEqual([]);

    // Performance contract: only fd subprocess, no git branch
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync.mock.calls[0][0]).toContain("fd");
  });
});

// ─── Cache management ─────────────────────────────────────────

describe("workspace cache (default singleton)", () => {
  beforeEach(() => {
    resetWorkspaceCache();
    resetAllMocks();
  });

  it("getWorkspaceCache returns disk cache when available (no subprocesses)", () => {
    const diskCache: WorkspaceCache = {
      repos: [
        {
          path: "/cached/repo",
          name: "repo",
          branches: ["main"],
        },
      ],
      scannedAt: 100,
      basePath: process.cwd(),
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(diskCache));
    mockExistsSync.mockReturnValue(true); // cache dir exists

    const cache = getWorkspaceCache();
    expect(cache.repos).toHaveLength(1);
    expect(cache.repos[0].name).toBe("repo");

    // No subprocesses spawned
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("getWorkspaceCache runs discovery when no disk cache", () => {
    // Disk cache read fails
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockExistsSync.mockReturnValue(true); // base dir exists
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    const cache = getWorkspaceCache();
    expect(cache).toHaveProperty("repos");
    expect(cache).toHaveProperty("scannedAt");
    expect(cache).toHaveProperty("basePath");
    expect(typeof cache.scannedAt).toBe("number");
  });

  it("getWorkspaceCache returns in-memory cache without hitting disk", () => {
    // Populate in-memory cache first via discover
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    discoverWorkspace("/tmp");
    mockReadFileSync.mockReset(); // should not be called

    const cache = getWorkspaceCache();
    expect(cache.basePath).toBe("/tmp");
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("refreshWorkspace performs incremental refresh when cache exists (no fd)", () => {
    const existingCache: WorkspaceCache = {
      repos: [
        { path: "/tmp/repo-a", name: "repo-a", branches: ["main"] },
        { path: "/tmp/repo-deleted", name: "repo-deleted", branches: [] },
      ],
      scannedAt: 100,
      basePath: "/tmp",
    };
    resetWorkspaceCache();
    mockReadFileSync.mockReturnValue(JSON.stringify(existingCache));
    // repo-a .git exists, repo-deleted .git is gone, repo-c .git exists (new)
    mockExistsSync.mockImplementation((path: string) => {
      if (
        path === "/tmp" ||
        path === "/tmp/repo-a" ||
        path === "/tmp/repo-a/.git" ||
        path === "/tmp/repo-c/.git"
      ) {
        return true;
      }
      return false;
    });
    // readdir returns all entries
    mockReaddirSync.mockReturnValue([
      { name: "repo-a", isDirectory: () => true },
      { name: "repo-deleted", isDirectory: () => true },
      { name: "repo-c", isDirectory: () => true },
      { name: "some-file.txt", isDirectory: () => false },
    ]);

    const cache = refreshWorkspace("/tmp");

    // repo-a kept, repo-deleted dropped, repo-c added
    expect(cache.repos).toHaveLength(2);
    expect(cache.repos[0].name).toBe("repo-a");
    expect(cache.repos[1].name).toBe("repo-c");
    // Branches: kept from cache for repo-a, lazy for repo-c
    expect(cache.repos[0].branches).toEqual(["main"]);
    expect(cache.repos[1].branches).toEqual([]);

    // No fd or git subprocess was spawned
    expect(mockExecSync).not.toHaveBeenCalled();

    // Cache was persisted to disk
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string,
    ) as WorkspaceCache;
    expect(written.repos).toHaveLength(2);
  });

  it("refreshWorkspace falls back to full scan when no cache exists", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    const cache = refreshWorkspace("/tmp");
    expect(cache.basePath).toBe("/tmp");
    // fd was called (full scan occurred)
    const allCmds = mockExecSync.mock.calls.map((c: any[]) => c[0]);
    const fdCalls = allCmds.filter((c: string) => c.includes("fd"));
    expect(fdCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("refreshWorkspace replaces existing cache", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });
    mockReaddirSync.mockReturnValue([]);

    const cache1 = discoverWorkspace("/tmp");
    const firstScannedAt = cache1.scannedAt;

    const cache2 = refreshWorkspace("/other");
    expect(cache2.basePath).toBe("/other");
    expect(cache2.scannedAt).toBeGreaterThanOrEqual(firstScannedAt);
  });

  it("resetWorkspaceCache clears the in-memory cache", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });
    mockReaddirSync.mockReturnValue([]);

    discoverWorkspace("/tmp");
    expect(getWorkspaceCache("/tmp")).toBeTruthy();

    resetWorkspaceCache();

    const diskCache: WorkspaceCache = {
      repos: [{ path: "/tmp/repo", name: "repo", branches: ["main"] }],
      scannedAt: 100,
      basePath: "/tmp",
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(diskCache));
    mockExistsSync.mockReturnValue(true);

    const cache = getWorkspaceCache("/tmp");
    expect(cache).toBeTruthy();
    expect(cache.repos).toHaveLength(1);
  });

  it("discoverWorkspace persists to disk", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });

    discoverWorkspace("/tmp");
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, _content, encoding] = mockWriteFileSync.mock.calls[0];
    expect(path).toBe("/fake-home/.pi-webterm/workspace-cache.json");
    expect(encoding).toBe("utf-8");
  });
});

// ─── WorkspaceScanner class (clean instance, no state leakage) ─

describe("WorkspaceScanner class", () => {
  let scanner: WorkspaceScanner;

  beforeEach(() => {
    scanner = new WorkspaceScanner();
    resetAllMocks();
  });

  it("fresh instance has no shared state with singleton", () => {
    // The default singleton may have state; a fresh instance is clean
    expect(scanner).toBeInstanceOf(WorkspaceScanner);
  });

  it("getWorkspaceCache on fresh instance falls through to disk cache", () => {
    const diskCache: WorkspaceCache = {
      repos: [{ path: "/cached/repo", name: "repo", branches: ["main"] }],
      scannedAt: 100,
      basePath: process.cwd(),
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(diskCache));
    mockExistsSync.mockReturnValue(true);

    const cache = scanner.getWorkspaceCache();
    expect(cache.repos).toHaveLength(1);
    expect(cache.repos[0].name).toBe("repo");
  });

  it("resetCache forces next getWorkspaceCache to read from disk", () => {
    resetAllMocks();

    // Populate in-memory cache via discover
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "";
      if (cmd.includes("git")) return "";
      return "";
    });
    mockReaddirSync.mockReturnValue([]);

    scanner.discoverWorkspace("/tmp");
    expect(scanner.getWorkspaceCache("/tmp")).toBeTruthy();

    // Reset — next getWorkspaceCache must read from disk
    scanner.resetCache();

    const diskCache: WorkspaceCache = {
      repos: [{ path: "/tmp/repo", name: "repo", branches: ["main"] }],
      scannedAt: 100,
      basePath: "/tmp",
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(diskCache));
    mockExistsSync.mockReturnValue(true);

    const cache = scanner.getWorkspaceCache("/tmp");
    expect(cache.repos).toHaveLength(1);
    expect(cache.repos[0].name).toBe("repo");
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("two scanner instances do not share cache", () => {
    const scannerA = new WorkspaceScanner();
    const scannerB = new WorkspaceScanner();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fd")) return "/tmp/repo-a/.git\n";
      if (cmd.includes("git")) return "main\n";
      return "";
    });
    mockReaddirSync.mockReturnValue([]);

    // Set up disk cache for scanner B
    const diskCache: WorkspaceCache = {
      repos: [
        { path: "/cached/repo", name: "cached-repo", branches: ["main"] },
      ],
      scannedAt: 100,
      basePath: "/tmp",
    };

    // scannerA: full scan
    scannerA.discoverWorkspace("/tmp");
    // scannerB: disk cache
    mockReadFileSync.mockReturnValue(JSON.stringify(diskCache));
    mockExistsSync.mockReturnValue(true);

    const cacheA = scannerA.getWorkspaceCache("/tmp");
    const cacheB = scannerB.getWorkspaceCache("/tmp");

    expect(cacheA.repos[0].name).toBe("repo-a");
    expect(cacheB.repos[0].name).toBe("cached-repo");
  });
});
