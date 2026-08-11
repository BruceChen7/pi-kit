/**
 * Shared artifact materialization pipeline.
 *
 * Both `create_visual_artifact` and `create_calldiff_artifact` funnel through
 * here so there is exactly one implementation of:
 *
 *   resolve (expand `calldiff-callflow` nodes) → validate → mermaid validate
 *   → write to store → open Glimpse window → phrase the tool result.
 *
 * IO lives here (store, window); the expansion itself is delegated to
 * `resolve-calldiff-node.ts` (core). Window opening and feedback delivery are
 * injectable so tests can drive the pipeline without a real Glimpse window.
 */

import { runCalldiffJson } from "../shared/calldiff-runner.ts";
import { type VisualArtifactSpec, validate } from "./artifact-schema.ts";
import { writeArtifact } from "./artifact-store.ts";
import { calldiffResultToSpec, parseCalldiffJson } from "./calldiff-bridge.ts";
import {
  type OpenVisualArtifactWindowOptions,
  openVisualArtifactWindow,
} from "./glimpse-host.ts";
import {
  formatMermaidValidationErrors,
  validateMermaidNodesInSpec,
} from "./mermaid-boundary.ts";
import { deriveProjectName, getDefaultProjectRoot } from "./paths.ts";
import {
  type CalldiffReport,
  resolveCalldiffNodes,
} from "./resolve-calldiff-node.ts";

export type PipelineLogger = {
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type MaterializeDeps = {
  /** Session working directory — used only when a calldiff node is present. */
  cwd: string | undefined;
  signal?: AbortSignal;
  baseText: string;
  /**
   * Standalone mode: when every calldiff node degrades and there is no other
   * content (typical for the single-node `create_calldiff_artifact`), fail
   * the whole call BEFORE writing/opening instead of rendering a useless
   * "Call-flow unavailable" artifact. Embedded nodes inside richer artifacts
   * still degrade (default false).
   */
  strictCalldiff?: boolean;
  openWindow?: OpenVisualArtifactWindowOptions["openWindow"];
  sendFeedback: (text: string) => Promise<void>;
  log: PipelineLogger;
  writeArtifactFn?: typeof writeArtifact;
};

export type MaterializeResult =
  | { ok: true; text: string; reports: CalldiffReport[] }
  | { ok: false; text: string };

/**
 * Create a VisualArtifactBootData-compatible boot payload for an artifact.
 * Shared by both tools so the window always opens on the exact spec that was
 * validated and written.
 */
const bootFor = (
  spec: VisualArtifactSpec,
  projectName: string,
): OpenVisualArtifactWindowOptions["bootData"] => ({
  view: "artifact",
  projectName,
  artifactSlug: spec.slug,
  artifactSpec: spec,
});

const summarizeReports = (reports: CalldiffReport[]): string | null => {
  if (reports.length === 0) return null;
  const failures = reports.filter((r) => !r.ok).length;
  const lines = reports.map((r) => r.summary);
  const suffix =
    failures > 0
      ? ` (${failures} node(s) degraded to 'Call-flow unavailable')`
      : "";
  return `Call-flow: ${lines.join("; ")}${suffix}`;
};

export const materializeArtifact = async (
  spec: VisualArtifactSpec,
  deps: MaterializeDeps,
): Promise<MaterializeResult> => {
  const log = deps.log;

  /* ---- 1. Validate the declared spec BEFORE any subprocess IO ----
     `calldiff-callflow` is a registered catalog type, so a spec that still
     contains macro nodes validates here; a broken spec fails fast without
     burning calldiff subprocesses on the resolve step. */
  const declared = validate(spec);
  if (declared.ok === false) {
    return {
      ok: false,
      text: `Validation failed:\n- ${declared.errors.join("\n- ")}`,
    };
  }

  /* ---- 2. Resolve macro nodes (host-side calldiff expansion) ---- */
  const resolved = await resolveCalldiffNodes(declared.spec, {
    cwd: deps.cwd,
    signal: deps.signal,
    runCalldiffJson,
    parseCalldiffJson,
    calldiffResultToSpec,
  });
  const specToRender = resolved.spec;

  /* ---- 2b. Strict standalone mode: all-degraded calldiff is a hard failure ---- */
  if (
    deps.strictCalldiff === true &&
    resolved.reports.length > 0 &&
    resolved.reports.every((report) => report.ok === false)
  ) {
    const reasons = resolved.reports.map((report) =>
      report.summary
        .replace(/^calldiff unavailable: /, "")
        .replace(/^calldiff-callflow: /, ""),
    );
    return { ok: false, text: `calldiff failed: ${reasons.join("; ")}` };
  }

  /* ---- 3. Re-validate the fully expanded spec (limits + structure) ---- */
  const validated = validate(specToRender);
  if (validated.ok === false) {
    return {
      ok: false,
      text: `Validation failed:\n- ${validated.errors.join("\n- ")}`,
    };
  }

  /* ---- 4. Mermaid validation: every mermaid node in the expanded spec —
     agent-authored AND bridge-generated diagrams — is checked against the
     real parser. ---- */
  const { errors: mermaidErrors } = await validateMermaidNodesInSpec(
    validated.spec,
  );
  if (mermaidErrors.length > 0) {
    log.warn(`Mermaid validation failed:\n${mermaidErrors.join("\n")}`);
    return { ok: false, text: formatMermaidValidationErrors(mermaidErrors) };
  }

  /* ---- 5. Write the self-contained (expanded) snapshot ---- */
  const projectRoot = getDefaultProjectRoot();
  const projectName = deriveProjectName(projectRoot);
  const write = deps.writeArtifactFn ?? writeArtifact;
  write(projectRoot, projectName, validated.spec);

  /* ---- 6. Open the window ---- */
  try {
    await openVisualArtifactWindow({
      bootData: bootFor(validated.spec, projectName),
      projectRoot,
      projectName,
      sendFeedback: deps.sendFeedback,
      ...(deps.openWindow ? { openWindow: deps.openWindow } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to open Glimpse window: ${message}`);
    return {
      ok: false,
      text:
        `Artifact saved, but failed to open Glimpse window: ${message}. ` +
        "It can be opened later via the /visual-artifact command.",
    };
  }

  /* ---- 6. Phrase the result (append calldiff summaries when present) ---- */
  const summary = summarizeReports(resolved.reports);
  const text = summary ? `${deps.baseText}\n\n${summary}` : deps.baseText;
  return { ok: true, text, reports: resolved.reports };
};
