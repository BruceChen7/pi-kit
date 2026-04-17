import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type FeatureRecord,
  listFeatureRecords,
  readFeatureRecord,
  writeFeatureRecord,
} from "./storage.js";

const createTempRepo = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-feature-workflow-"));

describe("storage", () => {
  it("writes and reads feature records", () => {
    const repoRoot = createTempRepo();

    const record: FeatureRecord = {
      id: "feat-checkout-v2",
      name: "Checkout V2",
      type: "feat",
      slug: "checkout-v2",
      branch: "feat/checkout-v2",
      base: "main",
      worktreePath: "/tmp/repo.feat-checkout-v2",
      status: "active",
      createdAt: "2026-04-17T00:00:00Z",
      updatedAt: "2026-04-17T00:00:00Z",
    };

    writeFeatureRecord(repoRoot, record);
    expect(readFeatureRecord(repoRoot, record.id)).toEqual(record);
  });

  it("lists records from wt list json and merges stored session metadata", () => {
    const repoRoot = createTempRepo();

    writeFeatureRecord(repoRoot, {
      id: "feat-b",
      name: "Feature B",
      type: "feat",
      slug: "b",
      branch: "feat/b",
      base: "main",
      worktreePath: "/tmp/old-b",
      sessionPath: "/tmp/session-b.json",
      status: "active",
      createdAt: "2026-04-17T00:00:00Z",
      updatedAt: "2026-04-17T00:00:00Z",
    });

    const wtListJson = JSON.stringify([
      {
        branch: "feat/a",
        path: "/tmp/a",
        commit: { timestamp: 100 },
      },
      {
        branch: "feat/b",
        path: "/tmp/b",
        commit: { timestamp: 200 },
      },
      {
        branch: "feature/legacy",
        path: "/tmp/legacy",
        commit: { timestamp: 300 },
      },
    ]);

    const records = listFeatureRecords(repoRoot, wtListJson);

    expect(records.map((r) => r.id)).toEqual(["feat-b", "feat-a"]);
    expect(records[0]).toMatchObject({
      id: "feat-b",
      branch: "feat/b",
      worktreePath: "/tmp/b",
      sessionPath: "/tmp/session-b.json",
      base: "main",
    });
  });
});
