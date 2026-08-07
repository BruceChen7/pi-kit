/**
 * Tasks db — JSON file persistence (Imperative Shell).
 *
 * Responsibilities: locate the db file, read/write it atomically, validate
 * on load, and provide a load-modify-save transaction helper. No business
 * logic lives here.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type TasksDb, tasksDbSchema } from "./contract.ts";
import { emptyDb } from "./store.ts";

export const TASKS_FILE_NAME = "tasks.json";

/** Default location: <projectRoot>/.pi/tasks/tasks.json */
export function defaultDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".pi", "tasks", TASKS_FILE_NAME);
}

export async function readDb(dbPath: string): Promise<TasksDb> {
  let raw: string;
  try {
    raw = await readFile(dbPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyDb();
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const result = tasksDbSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Tasks db is invalid at ${dbPath}: ${result.error.message}`,
    );
  }
  return result.data;
}

export async function writeDb(dbPath: string, db: TasksDb): Promise<void> {
  const dir = path.dirname(dbPath);
  await mkdir(dir, { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await rename(tmp, dbPath);
}

/**
 * Load-modify-save transaction. The mutation is a pure function
 * (value in -> value out); IO is confined to this helper.
 *
 * The mutation returns the full next db plus a typed result; only the
 * result is returned to the caller.
 */
export async function withDb<T>(
  dbPath: string,
  mutate: (db: TasksDb) => { db: TasksDb; result: T },
): Promise<T> {
  const current = await readDb(dbPath);
  const { db: next, result } = mutate(current);
  await writeDb(dbPath, next);
  return result;
}
