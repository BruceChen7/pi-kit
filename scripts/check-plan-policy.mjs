#!/usr/bin/env node
/**
 * Check a plan artifact against the plan-mode format policy before submitting
 * it for review.
 *
 * Usage: node scripts/check-plan-policy.mjs <plan.md>
 * Exit:  0 policy holds (or does not apply), 1 policy rejects, 2 usage/IO error.
 */
import fs from "node:fs";
import path from "node:path";

// The extension module is a `.ts` file, and this package declares no "type":
// Node emits MODULE_TYPELESS_PACKAGE_JSON for it on every run, which would
// otherwise land in the output of a script meant to be checked often.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "MODULE_TYPELESS_PACKAGE_JSON") {
    console.warn(warning);
  }
});
const { checkPlanArtifact } = await import("./check-plan-policy-rules.mts");

/** Path the policy expects: repo-relative, starting at `.pi/plans/…`. */
const repoRelativePath = (target, cwd) => {
  const absolute = path.resolve(cwd, target);
  let directory = path.dirname(absolute);
  while (true) {
    if (fs.existsSync(path.join(directory, ".pi"))) {
      return path.relative(directory, absolute).split(path.sep).join("/");
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.relative(cwd, absolute).split(path.sep).join("/");
};

const [, , target] = process.argv;
if (target === undefined || target.startsWith("-")) {
  console.error("usage: node scripts/check-plan-policy.mjs <plan.md>");
  process.exit(2);
}

let content;
try {
  content = fs.readFileSync(target, "utf8");
} catch (error) {
  console.error(`cannot read ${target}: ${error.message}`);
  process.exit(2);
}

const result = checkPlanArtifact({
  artifactPath: repoRelativePath(target, process.cwd()),
  content,
});

console.log(result.output);
process.exit(result.ok ? 0 : 1);
