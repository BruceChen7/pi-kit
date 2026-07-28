export type VisualArtifactTheme = string;

export type VisualArtifactThemeOption = {
  id: VisualArtifactTheme;
  label: string;
};

export const VISUAL_ARTIFACT_THEMES: VisualArtifactThemeOption[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];
