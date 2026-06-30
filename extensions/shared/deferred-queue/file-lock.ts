import fs from "node:fs";
import path from "node:path";

const LOCK_TTL_MS = 180_000; // 3 minutes (fallback for PID-reuse edge case)

/**
 * A simple file-level exclusive lock using O_CREAT | O_EXCL.
 * Used to prevent duplicate task execution across multiple Pi processes.
 * Callers may pass a lock key to isolate independent resources/tasks.
 *
 * Crash recovery:
 * The lock file stores the PID of the holding process.
 * When checking staleness, we first verify if the PID is still alive
 * via `process.kill(pid, 0)`. If the process is dead, the lock is
 * immediately considered stale — no need to wait for TTL expiry.
 * TTL serves as a fallback for PID-reuse edge cases.
 */
export class FileLock {
  private readonly lockDir: string;
  private readonly lockBase: string;

  constructor(persistPath: string) {
    this.lockDir = path.dirname(persistPath);
    this.lockBase = path.basename(persistPath, path.extname(persistPath));
  }

  /**
   * Try to acquire the lock.
   * Returns true if acquired, false if another process holds it.
   * Stale locks (holding process dead, or older than TTL) are broken
   * automatically before retrying.
   */
  tryLock(key?: string): boolean {
    const lockPath = this.lockPathFor(key);

    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      // Write PID + timestamp for crash-recovery liveness checks
      fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
      fs.closeSync(fd);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock exists — check if stale
        if (this.isStale(lockPath)) {
          this.breakLock(lockPath);
          return this.tryLock(key); // Retry once
        }
        return false;
      }
      // On other errors (e.g., permission), allow execution without lock
      return true;
    }
  }

  /** Release the lock. */
  unlock(key?: string): void {
    try {
      fs.unlinkSync(this.lockPathFor(key));
    } catch {
      // Ignore — lock may have been broken by another process
    }
  }

  // ── Private ─────────────────────────────────────────────────

  private lockPathFor(key: string | undefined): string {
    if (!key) return path.join(this.lockDir, `${this.lockBase}.lock`);

    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.lockDir, `${this.lockBase}.${safeKey}.lock`);
  }

  /**
   * Read the PID stored in the lock file.
   * Returns null if the file can't be read, or the format is invalid
   * (e.g., old-format lock file without a PID).
   */
  private readLockPid(lockPath: string): number | null {
    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const colonIdx = content.indexOf(":");
      if (colonIdx === -1) return null; // old format, no PID
      const pidStr = content.slice(0, colonIdx);
      const pid = Number.parseInt(pidStr, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a PID corresponds to a live process.
   *
   * Uses `process.kill(pid, 0)` which is a standard POSIX liveness probe:
   * - Returns true if the process exists
   * - Throws ESRCH if no such process
   * - Throws EPERM if process exists but we lack permission (still alive)
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      // ESRCH: no such process → dead
      if (e.code === "ESRCH") return false;
      // EPERM/EACCES: process exists but no permission → alive
      // Any other error: assume alive to be safe
      return true;
    }
  }

  /**
   * Check if the lock is stale.
   *
   * Three-tier detection:
   * 1. PID-based: if the lock holder's PID is no longer alive → stale
   * 2. TTL-based: if mtime is older than LOCK_TTL_MS → stale (handles
   *    PID reuse and old-format locks)
   * 3. Error fallback: if we can't stat/read the file → stale
   */
  private isStale(lockPath: string): boolean {
    try {
      // Tier 1: PID-based liveness check (instant crash recovery)
      const pid = this.readLockPid(lockPath);
      if (pid !== null && !this.isPidAlive(pid)) {
        return true; // Holding process is dead → stale
      }

      // Tier 2: TTL check
      // (catches PID reuse, old-format locks without PID, permission
      //  errors reading content, or processes on a different machine
      //  sharing a networked filesystem)
      const stat = fs.statSync(lockPath);
      return Date.now() - stat.mtimeMs > LOCK_TTL_MS;
    } catch {
      // Tier 3: Can't stat/read → treat as stale (safe to break)
      return true;
    }
  }

  private breakLock(lockPath: string): void {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Race: another process already broke it
    }
  }
}
