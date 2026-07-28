/**
 * Smoke test — exercises the main logic chain without Glimpse.
 *
 * Run: npx tsx extensions/visual-artifact/smoke-test.ts
 */

import { applyMutations, readAnnotations } from "./annotation-store.ts";
import { validate } from "./artifact-schema.ts";
import {
  deleteArtifact,
  listArtifacts,
  listProjects,
  readArtifact,
  writeArtifact,
} from "./artifact-store.ts";
import { deriveProjectName, getDefaultProjectRoot } from "./paths.ts";

const PROJECT_ROOT = getDefaultProjectRoot();
const PROJECT = deriveProjectName(PROJECT_ROOT);
const SLUG = "smoke-test-report";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

/* ------------------------------------------------------------------ */
/*  1. Build a spec                                                   */
/* ------------------------------------------------------------------ */
console.log("\n1. Building spec...");

const spec = {
  slug: SLUG,
  title: "Smoke Test Report",
  description: "A spec created by the smoke test.",
  artifactType: "report" as const,
  topics: ["test", "smoke"],
  nodes: [
    { type: "text", props: { text: "Hello from smoke test.", size: "lg" } },
    {
      type: "card",
      props: {
        title: "Test Card",
        description: "A card with nested text",
        nodes: [{ type: "text", props: { text: "Inside card.", size: "sm" } }],
      },
    },
    { type: "stat-card", props: { label: "Items", value: 42, trend: "up" } },
    { type: "badge", props: { text: "beta", variant: "warning" } },
    { type: "divider", props: {} },
    {
      type: "table",
      props: {
        headers: ["Name", "Value"],
        rows: [
          ["a", "1"],
          ["b", "2"],
        ],
      },
    },
  ],
};

console.log(`  spec has ${spec.nodes.length} nodes`);
assert(spec.nodes.length === 6, "spec has 6 nodes");

/* ------------------------------------------------------------------ */
/*  2. Validate                                                       */
/* ------------------------------------------------------------------ */
console.log("\n2. Validating spec...");

const validated = validate(spec);
assert(validated.ok, "validation passes");
if (!validated.ok) {
  console.log(
    `  errors: ${(validated as { errors: string[] }).errors.join(", ")}`,
  );
  process.exit(1);
}

const vspec = validated.ok ? validated.spec : null;

/* ------------------------------------------------------------------ */
/*  3. Write artifact                                                 */
/* ------------------------------------------------------------------ */
console.log("\n3. Writing artifact...");
writeArtifact(PROJECT_ROOT, PROJECT, vspec!);
console.log(`  wrote to ${PROJECT_ROOT}/.pi/visual-artifact/artifacts/`);

const readBack = readArtifact(PROJECT_ROOT, PROJECT, SLUG);
assert(readBack !== null, "artifact can be read back");
assert(readBack?.title === "Smoke Test Report", "title matches");
assert(readBack?.nodes.length === 6, "nodes count matches");

/* ------------------------------------------------------------------ */
/*  4. List projects and artifacts                                    */
/* ------------------------------------------------------------------ */
console.log("\n4. Listing...");

const projects = listProjects(PROJECT_ROOT);
assert(projects.length > 0, "at least one project exists");
assert(projects.includes(PROJECT), `project "${PROJECT}" is listed`);

const artifacts = listArtifacts(PROJECT_ROOT, PROJECT);
assert(artifacts.length > 0, "at least one artifact in project");
const found = artifacts.find((a) => a.slug === SLUG);
assert(found !== undefined, `artifact "${SLUG}" is listed`);
assert(found?.title === "Smoke Test Report", "listed title matches");

/* ------------------------------------------------------------------ */
/*  5. Annotations                                                    */
/* ------------------------------------------------------------------ */
console.log("\n5. Testing annotations...");

const result1 = applyMutations(PROJECT_ROOT, PROJECT, SLUG, [
  {
    type: "createThread" as const,
    threadId: "thread-1",
    anchor: { nodeId: "node-0" },
    author: { name: "Smoke Tester" },
    body: "This is a test comment.",
  },
]);
assert(result1.threads.length === 1, "thread created");
assert(result1.threads[0].messages.length === 1, "thread has one message");
assert(result1.threads[0].status === "open", "thread is open");

const tid = result1.threads[0].id;
const result2 = applyMutations(PROJECT_ROOT, PROJECT, SLUG, [
  { type: "resolveThread" as const, threadId: tid },
]);
assert(result2.threads[0].status === "resolved", "thread resolved");

const persisted = readAnnotations(PROJECT_ROOT, PROJECT, SLUG);
assert(persisted !== null, "annotations persisted to disk");
assert(persisted?.threads.length === 1, "one thread on disk");
assert(
  persisted?.threads[0].status === "resolved",
  "resolved status persisted",
);

/* ------------------------------------------------------------------ */
/*  6. Validating invalid specs                                       */
/* ------------------------------------------------------------------ */
console.log("\n6. Testing invalid inputs...");

const noSlug = validate({ title: "No Slug", nodes: [] });
assert(!noSlug.ok, "rejects missing slug");

const noTitle = validate({ slug: "no-title", nodes: [] });
assert(!noTitle.ok, "rejects missing title");

const noNodes = validate({ slug: "no-nodes", title: "No Nodes" });
assert(!noNodes.ok, "rejects missing nodes array");

const badJson = validate(null);
assert(!badJson.ok, "rejects null");

/* ------------------------------------------------------------------ */
/*  7. Cleanup                                                        */
/* ------------------------------------------------------------------ */
console.log("\n7. Cleaning up...");
deleteArtifact(PROJECT_ROOT, PROJECT, SLUG);
const afterDelete = readArtifact(PROJECT_ROOT, PROJECT, SLUG);
assert(afterDelete === null, "artifact deleted successfully");

/* ------------------------------------------------------------------ */
/*  Summary                                                           */
/* ------------------------------------------------------------------ */
console.log("\n═══════════════════════════════════════");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log("═══════════════════════════════════════\n");

if (failed > 0) {
  process.exit(1);
}
