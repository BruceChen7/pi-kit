import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPlanArtifact } from "./check-plan-policy-rules.mts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const PLAN_PATH = ".pi/plans/probe/plan/2026-01-01-probe.md";

const COMPLIANT_PLAN = `# Probe

## Goal

One judgeable outcome.

## Current Flow

\`\`\`mermaid
graph LR
  A --> B
\`\`\`

## Desired Flow

\`\`\`mermaid
graph LR
  A --> C
\`\`\`

## Boundaries

\`\`\`mermaid
sequenceDiagram
  A->>B: call
\`\`\`

## Implementation

\`\`\`
shell
└─ core.ts
\`\`\`

## Testing

npx vitest run.

## Decisions

None.

## Non-goals

Nothing else.
`;

const withoutSection = (name: string): string =>
  COMPLIANT_PLAN.replace(new RegExp(`## ${name}\\n`), `## ${name} (moved)\n`);

describe("checkPlanArtifact", () => {
  it("passes a plan the submit-time policy accepts", () => {
    const result = checkPlanArtifact({
      artifactPath: PLAN_PATH,
      content: COMPLIANT_PLAN,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("OK");
  });

  it("reports the same failure text the submit path uses", () => {
    const result = checkPlanArtifact({
      artifactPath: PLAN_PATH,
      content: withoutSection("Boundaries"),
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      "Plan Mode artifact policy blocked review submission.",
    );
    expect(result.output).toContain(PLAN_PATH);
    expect(result.output).toContain("Boundaries");
  });

  it("flags an Implementation section without an ASCII call tree", () => {
    const result = checkPlanArtifact({
      artifactPath: PLAN_PATH,
      content: COMPLIANT_PLAN.replace("└─ core.ts", "core.ts, uses stuff"),
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Implementation");
  });

  it("says so when the policy does not apply to the path", () => {
    const result = checkPlanArtifact({
      artifactPath: ".pi/research/2026-01-01-note.md",
      content: "# Note\n",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("does not apply");
  });
});

describe("check-plan-policy.mjs", () => {
  const writeFixture = (content: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-policy-"));
    const file = path.join(
      root,
      ".pi/plans",
      "probe",
      "plan",
      "2026-01-01-probe.md",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  const run = (file: string): { status: number | null; stdout: string } => {
    try {
      const stdout = execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts/check-plan-policy.mjs"), file],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      return { status: 0, stdout };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      return { status: failed.status ?? null, stdout: failed.stdout ?? "" };
    }
  };

  it("exits 0 for a compliant plan given as an absolute path", () => {
    const file = writeFixture(COMPLIANT_PLAN);
    const { status, stdout } = run(file);

    expect(status).toBe(0);
    expect(stdout).toContain(".pi/plans/probe/plan/2026-01-01-probe.md");
  });

  it("exits 1 and prints the issues for a plan the policy rejects", () => {
    const file = writeFixture(withoutSection("Testing"));
    const { status, stdout } = run(file);

    expect(status).toBe(1);
    expect(stdout).toContain("Testing");
  });
});
