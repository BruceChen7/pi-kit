import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type KanbanRepoRecord = {
  repoId: string;
  repoPath: string;
  boardPath: string;
  defaultAdapter: string;
  createdAt: string;
  updatedAt: string;
};

export type KanbanTaskRecord = {
  taskId: string;
  repoId: string;
  cardId: string;
  intentType: string;
  runtimeState: string;
  conflict: boolean;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  request: Record<string, unknown> | null;
  summary: string | null;
};

export type KanbanSessionRecord = {
  sessionId: string;
  taskId: string;
  adapterType: string;
  adapterSessionRef: string;
  repoPath: string;
  worktreePath: string | null;
  status: string;
  resumable: boolean;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KanbanTaskEventRecord = {
  eventId: string;
  taskId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  ts: string;
};

export type KanbanHandoffRecord = {
  taskId: string;
  summary: string;
  artifacts: unknown[];
  generatedAt: string;
};

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export class KanbanLocalStateStore {
  private readonly db: DatabaseSync;

  constructor(input: { dbPath: string }) {
    fs.mkdirSync(path.dirname(input.dbPath), { recursive: true });
    this.db = new DatabaseSync(input.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS repo_registry (
        repo_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        board_path TEXT NOT NULL,
        default_adapter TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        runtime_state TEXT NOT NULL,
        conflict INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_json TEXT,
        summary TEXT,
        FOREIGN KEY (repo_id) REFERENCES repo_registry (repo_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        adapter_session_ref TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        worktree_path TEXT,
        status TEXT NOT NULL,
        resumable INTEGER NOT NULL,
        last_event_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (task_id)
      );

      CREATE TABLE IF NOT EXISTS task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        ts TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (task_id)
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        task_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (task_id)
      );
    `);

    const taskColumns = this.db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "conflict")) {
      this.db.exec(
        `ALTER TABLE tasks ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  registerRepo(record: KanbanRepoRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO repo_registry (
            repo_id,
            repo_path,
            board_path,
            default_adapter,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id) DO UPDATE SET
            repo_path = excluded.repo_path,
            board_path = excluded.board_path,
            default_adapter = excluded.default_adapter,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        record.repoId,
        record.repoPath,
        record.boardPath,
        record.defaultAdapter,
        record.createdAt,
        record.updatedAt,
      );
  }

  getRepo(repoId: string): KanbanRepoRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            repo_id,
            repo_path,
            board_path,
            default_adapter,
            created_at,
            updated_at
          FROM repo_registry
          WHERE repo_id = ?
        `,
      )
      .get(repoId) as
      | {
          repo_id: string;
          repo_path: string;
          board_path: string;
          default_adapter: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      repoId: row.repo_id,
      repoPath: row.repo_path,
      boardPath: row.board_path,
      defaultAdapter: row.default_adapter,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertTask(record: KanbanTaskRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO tasks (
            task_id,
            repo_id,
            card_id,
            intent_type,
            runtime_state,
            conflict,
            attempt,
            created_at,
            updated_at,
            request_json,
            summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            repo_id = excluded.repo_id,
            card_id = excluded.card_id,
            intent_type = excluded.intent_type,
            runtime_state = excluded.runtime_state,
            conflict = excluded.conflict,
            attempt = excluded.attempt,
            updated_at = excluded.updated_at,
            request_json = excluded.request_json,
            summary = excluded.summary
        `,
      )
      .run(
        record.taskId,
        record.repoId,
        record.cardId,
        record.intentType,
        record.runtimeState,
        record.conflict ? 1 : 0,
        record.attempt,
        record.createdAt,
        record.updatedAt,
        stringifyJson(record.request),
        record.summary,
      );
  }

  getTask(taskId: string): KanbanTaskRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            task_id,
            repo_id,
            card_id,
            intent_type,
            runtime_state,
            conflict,
            attempt,
            created_at,
            updated_at,
            request_json,
            summary
          FROM tasks
          WHERE task_id = ?
        `,
      )
      .get(taskId) as
      | {
          task_id: string;
          repo_id: string;
          card_id: string;
          intent_type: string;
          runtime_state: string;
          conflict: number;
          attempt: number;
          created_at: string;
          updated_at: string;
          request_json: string | null;
          summary: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      taskId: row.task_id,
      repoId: row.repo_id,
      cardId: row.card_id,
      intentType: row.intent_type,
      runtimeState: row.runtime_state,
      conflict: row.conflict === 1,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      request: parseJson<Record<string, unknown>>(row.request_json),
      summary: row.summary,
    };
  }

  listTasksByRepo(repoId: string): KanbanTaskRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            task_id,
            repo_id,
            card_id,
            intent_type,
            runtime_state,
            conflict,
            attempt,
            created_at,
            updated_at,
            request_json,
            summary
          FROM tasks
          WHERE repo_id = ?
          ORDER BY created_at ASC, task_id ASC
        `,
      )
      .all(repoId) as Array<{
      task_id: string;
      repo_id: string;
      card_id: string;
      intent_type: string;
      runtime_state: string;
      conflict: number;
      attempt: number;
      created_at: string;
      updated_at: string;
      request_json: string | null;
      summary: string | null;
    }>;

    return rows.map((row) => ({
      taskId: row.task_id,
      repoId: row.repo_id,
      cardId: row.card_id,
      intentType: row.intent_type,
      runtimeState: row.runtime_state,
      conflict: row.conflict === 1,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      request: parseJson<Record<string, unknown>>(row.request_json),
      summary: row.summary,
    }));
  }

  upsertSession(record: KanbanSessionRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO sessions (
            session_id,
            task_id,
            adapter_type,
            adapter_session_ref,
            repo_path,
            worktree_path,
            status,
            resumable,
            last_event_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            task_id = excluded.task_id,
            adapter_type = excluded.adapter_type,
            adapter_session_ref = excluded.adapter_session_ref,
            repo_path = excluded.repo_path,
            worktree_path = excluded.worktree_path,
            status = excluded.status,
            resumable = excluded.resumable,
            last_event_at = excluded.last_event_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        record.sessionId,
        record.taskId,
        record.adapterType,
        record.adapterSessionRef,
        record.repoPath,
        record.worktreePath,
        record.status,
        record.resumable ? 1 : 0,
        record.lastEventAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  getSessionByTask(taskId: string): KanbanSessionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id,
            task_id,
            adapter_type,
            adapter_session_ref,
            repo_path,
            worktree_path,
            status,
            resumable,
            last_event_at,
            created_at,
            updated_at
          FROM sessions
          WHERE task_id = ?
          ORDER BY updated_at DESC, session_id DESC
          LIMIT 1
        `,
      )
      .get(taskId) as
      | {
          session_id: string;
          task_id: string;
          adapter_type: string;
          adapter_session_ref: string;
          repo_path: string;
          worktree_path: string | null;
          status: string;
          resumable: number;
          last_event_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      taskId: row.task_id,
      adapterType: row.adapter_type,
      adapterSessionRef: row.adapter_session_ref,
      repoPath: row.repo_path,
      worktreePath: row.worktree_path,
      status: row.status,
      resumable: row.resumable === 1,
      lastEventAt: row.last_event_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  appendTaskEvent(record: KanbanTaskEventRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO task_events (
            event_id,
            task_id,
            event_type,
            payload_json,
            ts
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.eventId,
        record.taskId,
        record.eventType,
        stringifyJson(record.payload),
        record.ts,
      );
  }

  listTaskEvents(taskId: string): KanbanTaskEventRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            event_id,
            task_id,
            event_type,
            payload_json,
            ts
          FROM task_events
          WHERE task_id = ?
          ORDER BY ts ASC, rowid ASC
        `,
      )
      .all(taskId) as Array<{
      event_id: string;
      task_id: string;
      event_type: string;
      payload_json: string | null;
      ts: string;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      taskId: row.task_id,
      eventType: row.event_type,
      payload: parseJson<Record<string, unknown>>(row.payload_json),
      ts: row.ts,
    }));
  }

  upsertHandoff(record: KanbanHandoffRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO handoffs (
            task_id,
            summary,
            artifacts_json,
            generated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            summary = excluded.summary,
            artifacts_json = excluded.artifacts_json,
            generated_at = excluded.generated_at
        `,
      )
      .run(
        record.taskId,
        record.summary,
        JSON.stringify(record.artifacts),
        record.generatedAt,
      );
  }

  getHandoff(taskId: string): KanbanHandoffRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT task_id, summary, artifacts_json, generated_at
          FROM handoffs
          WHERE task_id = ?
        `,
      )
      .get(taskId) as
      | {
          task_id: string;
          summary: string;
          artifacts_json: string;
          generated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      taskId: row.task_id,
      summary: row.summary,
      artifacts: JSON.parse(row.artifacts_json) as unknown[],
      generatedAt: row.generated_at,
    };
  }
}
