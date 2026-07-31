/**
 * concept-lock.mjs — Inter-process lock for concept file mutations.
 *
 * wiki-concept.mjs mutates shared concept files with read-modify-write cycles
 * (read the file, insert a bullet, write it back). When multiple Pi subagents
 * run wiki-summarize batches concurrently, two agents can read the same
 * concept file, then both write — silently dropping one agent's update
 * (lost update / last-write-wins).
 *
 * This module serializes mutations of the same concept across processes via
 * an atomic O_CREAT|O_EXCL lock file in the OS temp dir (kept out of the
 * knowledge base repo so it never pollutes `git status`).
 *
 * Crash recovery:
 * - Locks held by dead processes (PID liveness check) are stolen immediately.
 * - Locks older than LOCK_TTL_MS are stolen even if the PID is alive
 *   (fallback for the PID-reuse edge case).
 * - Acquisition gives up after LOCK_WAIT_MS with a descriptive error, so a
 *   stuck holder fails loudly instead of blocking forever.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCK_TTL_MS = 60_000; // mutations are sub-second; generous TTL
export const LOCK_WAIT_MS = 15_000; // give up waiting after this long
export const LOCK_RETRY_MS = 50;

/** Deterministic per-knowledge-base lock directory (hash of concepts dir). */
export function conceptLockDir(conceptsDir) {
  const hash = fnv1a(conceptsDir).toString(36);
  return path.join(os.tmpdir(), "pi-kit-concept-locks", hash);
}

/** Path of the lock file guarding mutations of a concept slug. */
export function conceptLockPath(conceptsDir, slug) {
  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(conceptLockDir(conceptsDir), `${safeSlug}.lock`);
}

/**
 * Run `fn` while holding an exclusive lock for `lockPath`.
 *
 * Returns fn's return value. Throws if the lock cannot be acquired within
 * `opts.waitMs` (default LOCK_WAIT_MS). `fn` may be sync or async.
 *
 * Note: `fn` must not call `process.exit` — a hard exit skips the release
 * path; the leftover lock is recovered on the next attempt via the
 * dead-PID staleness check, but relying on that in normal flow is wasteful.
 */
export async function withConceptLock(lockPath, fn, opts = {}) {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const ttlMs = opts.ttlMs ?? LOCK_TTL_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (isStale(lockPath, ttlMs)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process stole it first — retry the acquire.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${waitMs}ms waiting for concept lock: ${lockPath}`,
        );
      }
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Lock already removed (e.g. stolen after TTL) — nothing to do.
    }
  }
}

// ── Private ───────────────────────────────────────────────────────────────

function isStale(lockPath, ttlMs) {
  try {
    const content = fs.readFileSync(lockPath, "utf8");
    const pid = Number.parseInt(content.split(":")[0], 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch {
        return true; // holder process is dead
      }
    }
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > ttlMs;
  } catch {
    return true; // unreadable lock — treat as stale and retry
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FNV-1a 32-bit hash — stable across processes, no imports needed. */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
