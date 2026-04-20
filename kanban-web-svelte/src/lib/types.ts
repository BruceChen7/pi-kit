export type BoardLane =
  | "Inbox"
  | "Spec"
  | "Ready"
  | "In Progress"
  | "Review"
  | "Done";

export type BoardCard = {
  id: string;
  title: string;
  kind: "feature" | "child";
  parentId: string | null;
  lane: BoardLane;
  lineNumber: number;
  depth: 0 | 1;
};

export type BoardSnapshot = {
  path: string;
  lanes: Array<{
    name: BoardLane;
    cards: BoardCard[];
  }>;
  cards: BoardCard[];
  errors: string[];
};

export type CardContext = {
  cardId: string;
  title: string;
  kind: "feature" | "child";
  lane: BoardLane;
  parentCardId: string | null;
  branch: string | null;
  baseBranch: string | null;
  mergeTarget: string | null;
  worktreePath: string | null;
  session: {
    chatJid: string;
    worktreePath: string;
    lastActiveAt: string;
  } | null;
};

export type ExecuteResponse = {
  requestId: string;
  status: "queued" | "running" | "success" | "failed";
};

export type ActionState = {
  requestId: string;
  action: string;
  cardId: string;
  worktreeKey: string;
  status: "queued" | "running" | "success" | "failed";
  summary: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};
