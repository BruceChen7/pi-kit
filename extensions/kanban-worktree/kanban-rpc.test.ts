import { expect, test } from "vitest";

import {
  branchesListRequest,
  featuresLaunchRequest,
  KanbanRpcMethod,
  readIssueResult,
  readRpcError,
  requirementsCreateRequest,
  requirementsListRequest,
  requirementsRemoveRequest,
} from "./kanban-rpc.js";

test("builds kanban daemon rpc requests from typed inputs", () => {
  expect(requirementsListRequest()).toEqual({
    id: "initial-list",
    method: KanbanRpcMethod.RequirementsList,
  });
  expect(branchesListRequest()).toEqual({
    id: "branches-list",
    method: KanbanRpcMethod.BranchesList,
  });
  expect(
    requirementsCreateRequest({
      title: "Add board",
      baseBranch: "main",
      workBranch: "feature/add-board",
      launch: false,
      clientRequestId: "client-1",
    }),
  ).toEqual({
    id: "create-Add board",
    method: KanbanRpcMethod.RequirementsCreate,
    params: {
      title: "Add board",
      baseBranch: "main",
      workBranch: "feature/add-board",
    },
  });
  expect(
    featuresLaunchRequest({
      originProvider: "todo-workflow",
      originId: "add-board",
    }),
  ).toEqual({
    id: "launch-todo-workflow-add-board",
    method: KanbanRpcMethod.FeaturesLaunch,
    params: {
      originProvider: "todo-workflow",
      originId: "add-board",
    },
  });
  expect(
    requirementsRemoveRequest({
      originProvider: "todo-workflow",
      originId: "add-board",
    }),
  ).toEqual({
    id: "delete-todo-workflow-add-board",
    method: KanbanRpcMethod.RequirementsRemove,
    params: {
      originProvider: "todo-workflow",
      originId: "add-board",
    },
  });
});

test("reads rpc errors and normalizes legacy issue results", () => {
  expect(readRpcError({ error: { message: "boom" } })).toBe("boom");
  expect(
    readIssueResult({
      result: {
        id: "legacy-todo",
        description: "Legacy todo",
        status: "todo",
      },
    }),
  ).toEqual({
    issueId: "todo-workflow:legacy-todo",
    originProvider: "todo-workflow",
    originId: "legacy-todo",
    title: "Legacy todo",
    description: "Legacy todo",
    status: "in-box",
    repoRoot: "",
    baseBranch: "main",
    slug: "legacy-todo",
    workBranch: undefined,
    worktreePath: undefined,
    createdAt: "",
    updatedAt: "",
  });
});
