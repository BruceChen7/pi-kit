import fs from "node:fs";
import path from "node:path";

const LOCK_TTL_MS = 180_000; // 3 minutes

/**
 * A simple file-level exclusive lock using O_CREAT | O_EXCL.
 * Used to prevent duplicate task execution across multiple Pi processes.
 */
export class FileLock {
  private readonly lockPath: string;

  constructor(persistPath: string) {
    const dir = path.dirname(persistPath);
    const base = path.basename(persistPath, path.extname(persistPath));
    this.lockPath = path.join(dir, `${base}.lock`);
  }

  /**
   * Try to acquire the lock.
   * Returns true if acquired, false if another process holds it.
   * If the lock is stale (older than TTL), it's broken automatically.
   */
  tryLock(): boolean {
    try {
      const fd = fs.openSync(
        this.lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, String(Date.now()), "utf-8");
      fs.closeSync(fd);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock exists — check if stale
        if (this.isStale()) {
          this.breakLock();
          return this.tryLock(); // Retry once
        }
        return false;
      }
      // On other errors (e.g., permission), allow execution without lock
      return true;
    }
  }

  /** Release the lock. */
  unlock(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Ignore — lock may have been broken by another process
    }
  }

  private isStale(): boolean {
    try {
      const stat = fs.statSync(this.lockPath);
      return Date.now() - stat.mtimeMs > LOCK_TTL_MS;
    } catch {
      return true; // File doesn't exist or can't be read → treat as stale
    }
  }

  private breakLock(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Race: another process already broke it
    }
  }
}
