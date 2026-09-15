/**
 * Shared artifact materialization pipeline.
 *
 * `create_visual_artifact` funnels through here so there is exactly one
 * implementation of:
 *
 *   validate → mermaid validate → write to store → open Glimpse window
 *   → phrase the tool result.
 *
 * IO lives here (store, window); validation is delegated to
 * `artifact-schema.ts` (core). Feedback delivery is injectable so the
 * tools can route it to pi; the store/window IO is not injectable — tests
 * stub those modules at the module boundary instead.
 */

import { type VisualArtifactSpec, validate } from "./artifact-schema.ts";
import { writeArtifact } from "./artifact-store.ts";
import {
  type OpenVisualArtifactWindowOptions,
  openVisualArtifactWindow,
} from "./glimpse-host.ts";
import {
  formatMermaidValidationErrors,
  validateMermaidNodesInSpec,
} from "./mermaid-boundary.ts";
import { deriveProjectName, getDefaultProjectRoot } from "./paths.ts";

export type PipelineLogger = {
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type MaterializeDeps = {
  baseText: string;
  sendFeedback: (text: string) => Promise<void>;
  log: PipelineLogger;
};

export type MaterializeResult =
  | { ok: true; text: string }
  | { ok: false; text: string };

/**
 * Create a VisualArtifactBootData-compatible boot payload for an artifact,
 * so the window always opens on the exact spec that was validated and
 * written.
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

export const materializeArtifact = async (
  spec: VisualArtifactSpec,
  deps: MaterializeDeps,
): Promise<MaterializeResult> => {
  const log = deps.log;

  /* ---- 1. Validate the declared spec (pure core, value in → value out) ---- */
  const validated = validate(spec);
  if (validated.ok === false) {
    return {
      ok: false,
      text: `Validation failed:\n- ${validated.errors.join("\n- ")}`,
    };
  }

  /* ---- 2. Mermaid validation: every mermaid node in the spec is checked
     against the real parser. ---- */
  const { errors: mermaidErrors } = await validateMermaidNodesInSpec(
    validated.spec,
  );
  if (mermaidErrors.length > 0) {
    log.warn(`Mermaid validation failed:\n${mermaidErrors.join("\n")}`);
    return { ok: false, text: formatMermaidValidationErrors(mermaidErrors) };
  }

  /* ---- 3. Write the self-contained snapshot ---- */
  const projectRoot = getDefaultProjectRoot();
  const projectName = deriveProjectName(projectRoot);
  writeArtifact(projectRoot, projectName, validated.spec);

  /* ---- 4. Open the window ---- */
  try {
    await openVisualArtifactWindow({
      bootData: bootFor(validated.spec, projectName),
      projectRoot,
      projectName,
      sendFeedback: deps.sendFeedback,
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

  /* ---- 5. Phrase the result ---- */
  return { ok: true, text: deps.baseText };
};
