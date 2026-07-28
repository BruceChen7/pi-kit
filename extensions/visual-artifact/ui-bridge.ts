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
  getOrCreateAnnotations,
} from "./annotation-store.ts";
import type { VisualArtifactSpec } from "./artifact-schema.ts";
import {
  type ArtifactSummary,
  cleanAll,
  cleanProject,
  deleteArtifact,
  listArtifacts,
  listProjects,
  readArtifact,
} from "./artifact-store.ts";
import { getArtifactJsonPath } from "./paths.ts";

/* ------------------------------------------------------------------ */
/*  Message Protocol Types                                             */
/* ------------------------------------------------------------------ */

export type BridgeContext = {
  window: GlimpseWindow;
  projectRoot: string;
  projectName: string;
  sendFeedback: (text: string) => Promise<void>;
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
    }
  | { type: "delete-artifact"; projectName: string; slug: string }
  | { type: "clean-project"; projectName: string }
  | { type: "clean-all" }
  | {
      type: "feedback";
      items: { nodePath: string; body: string }[];
      slug?: string;
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
  | { type: "error"; message: string }
  | { type: "deleted"; projectName: string; slug: string }
  | { type: "project-cleaned"; projectName: string }
  | { type: "all-cleaned" }
  | { type: "feedback-sent"; projectName: string; slug: string };

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

    case "delete-artifact":
      if (
        typeof message.projectName !== "string" ||
        typeof message.slug !== "string"
      )
        return null;
      return {
        type: "delete-artifact",
        projectName: message.projectName,
        slug: message.slug,
      };

    case "clean-project":
      if (typeof message.projectName !== "string") return null;
      return { type: "clean-project", projectName: message.projectName };

    case "clean-all":
      return { type: "clean-all" };

    case "feedback":
      return {
        type: "feedback",
        items: Array.isArray(message.items)
          ? (message.items as { nodePath: string; body: string }[])
          : [],
        slug: typeof message.slug === "string" ? message.slug : undefined,
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
        const annotations = getOrCreateAnnotations(
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

      case "delete-artifact": {
        deleteArtifact(projectRoot, message.projectName, message.slug);
        dispatchEvent(window, {
          type: "deleted",
          projectName: message.projectName,
          slug: message.slug,
        });
        break;
      }

      case "clean-project": {
        cleanProject(projectRoot, message.projectName);
        dispatchEvent(window, {
          type: "project-cleaned",
          projectName: message.projectName,
        });
        break;
      }

      case "clean-all": {
        cleanAll(projectRoot);
        dispatchEvent(window, { type: "all-cleaned" });
        break;
      }

      case "feedback": {
        const slug = message.slug ?? "";
        const items = message.items ?? [];
        if (items.length === 0) {
          dispatchEvent(window, {
            type: "error",
            message: "No feedback items to send.",
          });
          break;
        }

        const specPath = getArtifactJsonPath(
          projectRoot,
          context.projectName,
          slug,
        );
        const lines: string[] = [
          "## 🎨 Visual Artifact Feedback",
          "",
          `**Project:** ${context.projectName}`,
          `**Slug:** ${slug}`,
          `**Spec path:** ${specPath}`,
          "",
          "Please modify `artifact.json` (the spec path above) to address the following feedback, then call `create_visual_artifact` with the same slug and updated nodes/data to re-open the artifact.",
          "",
        ];

        lines.push("### Feedback");
        lines.push("");
        for (const item of items) {
          lines.push(`- (${item.nodePath}) ${item.body}`);
        }

        const text = lines.join("\n");
        await context.sendFeedback(text);

        dispatchEvent(window, {
          type: "feedback-sent",
          projectName: context.projectName,
          slug,
        });
        window.close();
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
