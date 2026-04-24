import { describe, expect, it } from "vitest";

import {
  buildTodoActionOptions,
  pickCurrentSessionTodo,
} from "./interactions.js";
import type { TodoItem } from "./todo-store.js";

function createDoingTodo(input: {
  id: string;
  description: string;
  updatedAt: string;
  activeSessionKey?: string;
}): TodoItem {
  return {
    id: input.id,
    description: input.description,
    status: "doing",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    activeSessionKey: input.activeSessionKey,
  };
}

describe("todo interactions", () => {
  it("prefers the todo already active in the current session", () => {
    const currentSession = createDoingTodo({
      id: "current",
      description: "Current session todo",
      updatedAt: "2026-04-23T10:01:00.000Z",
      activeSessionKey: "session-a",
    });
    const otherDoing = createDoingTodo({
      id: "other",
      description: "Other doing todo",
      updatedAt: "2026-04-23T10:02:00.000Z",
    });

    expect(
      pickCurrentSessionTodo([otherDoing, currentSession], "session-a"),
    ).toEqual(currentSession);
  });

  it("returns null when no doing todo is active in the current session", () => {
    const otherSession = createDoingTodo({
      id: "other-session",
      description: "Other session todo",
      updatedAt: "2026-04-23T10:02:00.000Z",
      activeSessionKey: "session-b",
    });
    const unscopedDoing = createDoingTodo({
      id: "unscoped",
      description: "Unscoped doing todo",
      updatedAt: "2026-04-23T10:01:00.000Z",
    });

    expect(
      pickCurrentSessionTodo([otherSession, unscopedDoing], "session-a"),
    ).toBeNull();
  });

  it("builds the default action panel in the intended priority order", () => {
    expect(
      buildTodoActionOptions({
        hasCurrentTodo: true,
        hasQueuedTodo: true,
      }),
    ).toEqual([
      {
        label: "Resume current TODO",
        value: "resume-current",
      },
      {
        label: "Start a queued TODO",
        value: "start-queued",
      },
      {
        label: "Add a new TODO",
        value: "add-new",
      },
    ]);
  });
});
