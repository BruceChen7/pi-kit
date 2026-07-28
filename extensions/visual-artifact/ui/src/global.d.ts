type VisualArtifactBootData = {
  view: "home" | "project" | "artifact";
  projectName?: string;
  artifactSlug?: string;
  artifactSpec?: unknown;
  projects?: { name: string; artifactCount: number }[];
  artifacts?: { slug: string; title: string; description?: string }[];
};

type AnnotationDocument = {
  version: number;
  project: string;
  slug: string;
  threads: unknown[];
};

/**
 * CustomEvent detail types for bridge communication.
 * These are dispatched on window by the extension bridge.
 */
type VisualArtifactProjectsEvent = CustomEvent<{
  projects: { name: string; artifactCount: number }[];
}>;

type VisualArtifactArtifactsEvent = CustomEvent<{
  projectName: string;
  artifacts: { slug: string; title: string; description?: string }[];
}>;

type VisualArtifactArtifactEvent = CustomEvent<{
  projectName: string;
  slug: string;
  spec: unknown;
}>;

type VisualArtifactAnnotationsEvent = CustomEvent<{
  projectName: string;
  slug: string;
  annotations: AnnotationDocument;
}>;

type VisualArtifactAnnotationResultEvent = CustomEvent<{
  projectName: string;
  slug: string;
  annotations: AnnotationDocument;
}>;

type VisualArtifactErrorEvent = CustomEvent<{
  message: string;
}>;

declare global {
  interface Window {
    __VISUAL_ARTIFACT_BOOT__?: VisualArtifactBootData;
    glimpse?: {
      send(message: unknown): void;
      close(): void;
    };
  }

  interface WindowEventMap {
    "visual-artifact:projects": VisualArtifactProjectsEvent;
    "visual-artifact:artifacts": VisualArtifactArtifactsEvent;
    "visual-artifact:artifact": VisualArtifactArtifactEvent;
    "visual-artifact:annotations": VisualArtifactAnnotationsEvent;
    "visual-artifact:annotation-result": VisualArtifactAnnotationResultEvent;
    "visual-artifact:error": VisualArtifactErrorEvent;
  }
}

export {};
