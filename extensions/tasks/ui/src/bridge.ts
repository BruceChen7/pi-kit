// Bridge client — window side.
//
// Window → host:  window.glimpse.send({ type, ... })  (JSON message)
// Host → window:  window.dispatchEvent(new CustomEvent("tasks:snapshot", { detail: db }))
//                 window.dispatchEvent(new CustomEvent("tasks:error", { detail: message }))
//
// In the Glimpse native host, `window.glimpse.send` posts the object to the
// extension process (same shape as visual-artifact's bridge).

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

export type TasksDb = {
  version: number;
  folders: {
    id: string;
    name: string;
    parentFolderId: string | null;
    createdAt: string;
  }[];
  projects: {
    id: string;
    name: string;
    prefix: string;
    nextTaskNumber: number;
    color: string;
    folderId: string | null;
    createdAt: string;
  }[];
  tasks: {
    id: string;
    projectId: string;
    number: number;
    key: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: "urgent" | "high" | "medium" | "low" | "none";
    dueDate: string | null;
    parentTaskId: string | null;
    position: number;
    labelIds: string[];
    delegation: {
      agentId: string;
      startedAt: string;
      worktreePath?: string;
      branch?: string;
      baseBranch?: string;
      workspaceId?: string;
    } | null;
    createdAt: string;
    updatedAt: string;
  }[];
  labels: { id: string; projectId: string; name: string; color: string }[];
  comments: {
    id: string;
    taskId: string;
    kind: "user" | "agent" | "system";
    authorName: string;
    body: string;
    createdAt: string;
  }[];
};

export type Inbound =
  | { type: "get-snapshot" }
  | {
      type: "create-task";
      title: string;
      projectPrefix: string;
      priority?: string;
      status?: string;
      description?: string;
      labelNames?: string[];
      parentKey?: string;
    }
  | {
      type: "create-project";
      name: string;
      prefix: string;
      color: string;
      folderId?: string;
    }
  | {
      type: "update-project";
      projectId: string;
      name?: string;
      color?: string;
      folderId?: string;
    }
  | { type: "delete-project"; projectId: string }
  | { type: "create-folder"; name: string; parentFolderId?: string }
  | {
      type: "update-task";
      taskKey: string;
      status?: string;
      priority?: string;
      title?: string;
      description?: string;
    }
  | {
      type: "board-move";
      taskKey: string;
      status: TaskStatus;
      beforeKey?: string;
      afterKey?: string;
    }
  | { type: "comment"; taskKey: string; body: string }
  | {
      type: "delegate";
      taskKey: string;
      instructions?: string;
      worktree?: boolean;
      baseBranch?: string;
      branch?: string;
    }
  | { type: "reclaim"; taskKey: string }
  | { type: "delete-task"; taskKey: string }
  | { type: "worktree-remove"; taskKey: string; force?: boolean };

export type BridgeEvent =
  | { type: "snapshot"; db: TasksDb }
  | { type: "error"; message: string };

export function send(message: Inbound): void {
  window.glimpse?.send(message);
}

export function onBridgeEvent(handler: (event: BridgeEvent) => void): void {
  window.addEventListener("tasks:snapshot", ((e: CustomEvent) => {
    handler({ type: "snapshot", db: e.detail as TasksDb });
  }) as EventListener);
  window.addEventListener("tasks:error", ((e: CustomEvent) => {
    handler({ type: "error", message: String(e.detail) });
  }) as EventListener);
}

/** Fire-and-forget mutation: send and let the snapshot broadcast update UI. */
export function mutate(message: Inbound): void {
  send(message);
}
