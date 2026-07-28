type VisualArtifactBootData = {
  view: "home" | "project" | "artifact";
  projectName?: string;
  artifactSlug?: string;
  artifactSpec?: unknown;
  projects?: { name: string; artifactCount: number }[];
  artifacts?: { slug: string; title: string; description?: string }[];
};

declare global {
  interface Window {
    __VISUAL_ARTIFACT_BOOT__?: VisualArtifactBootData;
    glimpse?: {
      send(message: unknown): void;
      close(): void;
    };
  }
}

export {};
