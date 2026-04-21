import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RequirementService } from "./requirement-service";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const candidate = tempPaths.pop();
    if (candidate) {
      fs.rmSync(path.dirname(candidate), {
        recursive: true,
        force: true,
      });
    }
  }
});

function createService(): RequirementService {
  const statePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "kanban-requirements-")),
    "state.json",
  );
  tempPaths.push(statePath);
  return new RequirementService({
    repoRoot: "/repo/demo",
    workspaceId: "demo",
    statePath,
    now: (() => {
      let value = 0;
      return () => `2026-04-21T00:00:${String(value++).padStart(2, "0")}Z`;
    })(),
    createId: (() => {
      let value = 0;
      return () => `id-${++value}`;
    })(),
  });
}

describe("RequirementService", () => {
  it("returns empty-create mode when there are no unfinished requirements", () => {
    const service = createService();

    expect(service.getHome()).toEqual({
      mode: "empty-create",
      hasUnfinishedRequirements: false,
      lastViewedProjectId: null,
      recentProjects: [],
      projectGroups: [],
    });
  });

  it("creates requirements and groups them by project", () => {
    const service = createService();

    const detail = service.createRequirement({
      title: "Redesign kanban",
      prompt: "Build the new homepage",
      projectName: "pi-kit",
      projectPath: "/repo/demo",
    });

    expect(detail.requirement.boardStatus).toBe("inbox");
    expect(detail.requirement.runStage).toBe("launch");

    const home = service.getHome();
    expect(home.mode).toBe("project-board");
    expect(home.projectGroups).toHaveLength(1);
    expect(home.projectGroups[0]?.inbox[0]?.title).toBe("Redesign kanban");
    expect(home.projectGroups[0]?.done).toEqual([]);
  });

  it("starts, reopens, and completes prototype sessions", () => {
    const service = createService();
    const created = service.createRequirement({
      title: "Prototype session",
      prompt: "Simulate pi prompt",
      projectPath: "/repo/demo",
    });

    const running = service.startRequirement({
      requirementId: created.requirement.id,
      command: "pi Simulate pi prompt",
    });
    expect(running.requirement.runStage).toBe("running");
    expect(running.activeSession?.status).toBe("running");

    expect(
      service.sendTerminalInput(created.requirement.id, "continue"),
    ).toEqual({
      accepted: true,
      mode: "line",
    });

    const review = service.openReview(created.requirement.id);
    expect(review.requirement.runStage).toBe("review");

    const reopened = service.reopenReview(created.requirement.id);
    expect(reopened.requirement.runStage).toBe("running");

    const done = service.completeReview(created.requirement.id);
    expect(done.requirement.boardStatus).toBe("done");
    expect(done.requirement.runStage).toBe("done");
  });
});
