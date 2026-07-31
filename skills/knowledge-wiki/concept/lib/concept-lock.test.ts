import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  conceptLockDir,
  conceptLockPath,
  withConceptLock,
} from "./concept-lock.mjs";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "concept-lock-test-"));
}

describe("conceptLockPath", () => {
  it("derives a stable per-knowledge-base lock dir", () => {
    expect(conceptLockDir("/a/notes/Wiki/Concepts")).toBe(
      conceptLockDir("/a/notes/Wiki/Concepts"),
    );
    expect(conceptLockDir("/a/notes/Wiki/Concepts")).not.toBe(
      conceptLockDir("/b/notes/Wiki/Concepts"),
    );
  });

  it("sanitizes slugs into safe lock filenames", () => {
    const lockPath = conceptLockPath("/kb/Wiki/Concepts", "Foo/Bar Baz");
    expect(path.basename(lockPath)).toBe("Foo_Bar_Baz.lock");
  });
});

describe("withConceptLock", () => {
  it("creates and removes the lock file, returning fn's result", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    const result = await withConceptLock(lockPath, () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("supports async fns and preserves their result", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    const result = await withConceptLock(lockPath, async () => "async-ok");
    expect(result).toBe("async-ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when fn throws", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    await expect(
      withConceptLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("serializes concurrent mutations — no lost updates", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    let inside = 0;
    let maxInside = 0;
    let counter = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        withConceptLock(lockPath, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          const seen = counter; // simulate read-modify-write
          await new Promise((r) => setTimeout(r, 10));
          counter = seen + 1;
          inside--;
        }),
      ),
    );

    expect(counter).toBe(5); // every increment survived
    expect(maxInside).toBe(1); // strictly serialized
  });

  it("steals a lock left by a dead process", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    const dead = spawnSync(process.execPath, ["-e", ""]); // exited → dead pid
    fs.writeFileSync(lockPath, `${dead.pid}:${Date.now()}\n`);

    const result = await withConceptLock(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("waits for a live holder and proceeds after it releases", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}\n`);
    const timer = setTimeout(() => fs.unlinkSync(lockPath), 30);

    try {
      const result = await withConceptLock(lockPath, () => "ok", {
        waitMs: 2_000,
        retryMs: 5,
      });
      expect(result).toBe("ok");
    } finally {
      clearTimeout(timer);
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
  });

  it("throws when the lock cannot be acquired in time", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}\n`);

    await expect(
      withConceptLock(lockPath, () => "never", { waitMs: 50, retryMs: 5 }),
    ).rejects.toThrow(/Timed out after 50ms/);
  });

  it("steals locks older than the TTL even if the pid is alive", async () => {
    const lockPath = path.join(tmpDir(), "x.lock");
    // Live pid (this process) but an old mtime — PID-reuse fallback path.
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now() - 10_000}\n`);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, old, old);

    const result = await withConceptLock(lockPath, () => "ok", {
      ttlMs: 5_000,
    });
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
