export type OverviewAction = {
  id: string;
  label: string;
  disabled: boolean;
  hint: string;
};

export type InspectorTab = "terminal" | "context" | "logs" | "handoff";
