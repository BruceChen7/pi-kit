/**
 * Glimpse ↔ host message bridge for visual artifact.
 *
 * The host process receives messages from the Glimpse window via stdin,
 * processes them (reads/writes store), and dispatches results back
 * via CustomEvents dispatched on the Glimpse window.
 */

import type { GlimpseWindow } from "../shared/glimpse-window.ts";
import {
  type AnnotationMutation,
  applyMutations,
  readAnnotations,
} from "./annotation-store.ts";
import type { VisualArtifactSpec } from "./artifact-schema.ts";
import {
  type ArtifactSummary,
  listArtifacts,
  listProjects,
  readArtifact,
} from "./artifact-store.ts";

/* ------------------------------------------------------------------ */
/*  Message Protocol Types                                             */
/* ------------------------------------------------------------------ */

export type BridgeContext = {
  window: GlimpseWindow;
  projectRoot: string;
  projectName: string;
};

export type BridgeInboundMessage =
  | { type: "list-projects" }
  | { type: "list-artifacts"; projectName: string }
  | { type: "get-artifact"; projectName: string; slug: string }
  | { type: "list-annotations"; projectName: string; slug: string }
  | {
      type: "annotation-mutation";
      projectName: string;
      slug: string;
      mutations: AnnotationMutation[];
    };

export type BridgeOutboundEvent =
  | { type: "projects"; projects: { name: string; artifactCount: number }[] }
  | { type: "artifacts"; projectName: string; artifacts: ArtifactSummary[] }
  | {
      type: "artifact";
      projectName: string;
      slug: string;
      spec: VisualArtifactSpec | null;
    }
  | {
      type: "annotations";
      projectName: string;
      slug: string;
      annotations: unknown;
    }
  | {
      type: "annotation-result";
      projectName: string;
      slug: string;
      annotations: unknown;
    }
  | { type: "error"; message: string };

/* ------------------------------------------------------------------ */
/*  Message Routing                                                    */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInboundMessage(message: unknown): BridgeInboundMessage | null {
  if (!isRecord(message) || typeof message.type !== "string") return null;

  switch (message.type) {
    case "list-projects":
      return { type: "list-projects" };

    case "list-artifacts":
      if (typeof message.projectName !== "string") return null;
      return { type: "list-artifacts", projectName: message.projectName };

    case "get-artifact":
      if (
        typeof message.projectName !== "string" ||
        typeof message.slug !== "string"
      )
        return null;
      return {
        type: "get-artifact",
        projectName: message.projectName,
        slug: message.slug,
      };

    case "list-annotations":
      if (
        typeof message.projectName !== "string" ||
        typeof message.slug !== "string"
      )
        return null;
      return {
        type: "list-annotations",
        projectName: message.projectName,
        slug: message.slug,
      };

    case "annotation-mutation":
      if (
        typeof message.projectName !== "string" ||
        typeof message.slug !== "string" ||
        !Array.isArray(message.mutations)
      ) {
        return null;
      }
      return {
        type: "annotation-mutation",
        projectName: message.projectName,
        slug: message.slug,
        mutations: message.mutations as AnnotationMutation[],
      };

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Event Dispatch                                                     */
/* ------------------------------------------------------------------ */

function dispatchEvent(
  window: GlimpseWindow,
  event: BridgeOutboundEvent,
): void {
  const detail = escapeScriptJson(event);
  window.send?.(
    `window.dispatchEvent(new CustomEvent("visual-artifact:${event.type}", ` +
      `{ detail: ${detail} }));`,
  );
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

async function handleMessage(
  context: BridgeContext,
  message: BridgeInboundMessage,
): Promise<void> {
  const { window, projectRoot } = context;

  try {
    switch (message.type) {
      case "list-projects": {
        const projects = listProjects(projectRoot).map((name) => ({
          name,
          artifactCount: listArtifacts(projectRoot, name).length,
        }));
        dispatchEvent(window, { type: "projects", projects });
        break;
      }

      case "list-artifacts": {
        const artifacts = listArtifacts(projectRoot, message.projectName);
        dispatchEvent(window, {
          type: "artifacts",
          projectName: message.projectName,
          artifacts,
        });
        break;
      }

      case "get-artifact": {
        const spec = readArtifact(
          projectRoot,
          message.projectName,
          message.slug,
        );
        dispatchEvent(window, {
          type: "artifact",
          projectName: message.projectName,
          slug: message.slug,
          spec,
        });
        break;
      }

      case "list-annotations": {
        const annotations = readAnnotations(
          projectRoot,
          message.projectName,
          message.slug,
        );
        dispatchEvent(window, {
          type: "annotations",
          projectName: message.projectName,
          slug: message.slug,
          annotations,
        });
        break;
      }

      case "annotation-mutation": {
        const result = applyMutations(
          projectRoot,
          message.projectName,
          message.slug,
          message.mutations,
        );
        dispatchEvent(window, {
          type: "annotation-result",
          projectName: message.projectName,
          slug: message.slug,
          annotations: result,
        });
        break;
      }
    }
  } catch (error) {
    dispatchEvent(window, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Attach the bridge to a Glimpse window.
 * All inbound messages from the window are routed to the store and dispatched back as events.
 */
export function attachVisualArtifactBridge(context: BridgeContext): void {
  const { window } = context;

  window.on("message", async (message: unknown) => {
    const inbound = readInboundMessage(message);
    if (!inbound) return;
    await handleMessage(context, inbound);
  });
}
