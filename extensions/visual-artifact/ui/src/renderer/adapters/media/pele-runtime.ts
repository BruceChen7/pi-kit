/**
 * Pele diagram runtime for the visual-artifact UI.
 *
 * Artifact nodes of type `mermaid` carry Mermaid *syntax*; the UI renders them
 * with pele (obsidianmd/pele) — a zero-dependency, DOM-free Mermaid renderer
 * that emits themeable SVG. Two consequences shape this module:
 *
 * 1. Colors and fonts are CSS variables (`--pele-*`) resolved by the SVG at
 *    paint time, not a config object handed to an engine. The theme mapping
 *    lives here as data; the component only puts the variables on an ancestor.
 * 2. The UI build disables code splitting, so the bundle contains exactly the
 *    diagram types this module imports. Registering only what artifacts use is
 *    what keeps the bundle small.
 */

import { register, render } from "pele/core";
import classDiagram from "pele/diagrams/class";
import er from "pele/diagrams/er";
import flowchart from "pele/diagrams/flowchart";
import sequence from "pele/diagrams/sequence";
import state from "pele/diagrams/state";
import {
  condensePeleMessage,
  peleErrorColumn,
  peleErrorLine,
} from "../../../../../../shared/pele-error.ts";

export { condensePeleMessage };

export type DiagramAppTheme = string;

export type DiagramRenderInput = {
  theme: DiagramAppTheme;
  definition: string;
  fontFamily?: string;
};

/** Diagram types registered in the UI bundle (see module docblock). */
export const REGISTERED_DIAGRAM_TYPES = [
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
] as const;

/** Label font. Pelé measures text in it, so rendering and CSS must agree. */
export const DIAGRAM_FONT_FAMILY =
  '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Monospace label font, used by diagram types with code-ish labels. */
export const DIAGRAM_MONO_FONT_FAMILY =
  '"DM Mono", "SF Mono", "Fira Code", ui-monospace, monospace';

/**
 * Warm-neutral palette mapped onto pelé's CSS variables.
 * Values come from the app palette in styles/globals.css (ivory/paper/slate/
 * gray/clay/rust) so diagrams sit on the page instead of beside it.
 * Unlisted pelé variables (radius, series colors) keep pelé's defaults.
 */
const THEME_CSS_VARIABLES: Record<string, Record<string, string>> = {
  light: {
    "--pele-bg": "#ffffff",
    "--pele-fg": "#141413",
    "--pele-muted": "#6b6a63",
    "--pele-line": "#6b6a63",
    "--pele-surface": "#ffffff",
    "--pele-surface-alt": "#f0eee6",
    "--pele-border": "#d1cfc5",
    "--pele-accent": "#d97757",
    "--pele-critical": "#b04a3f",
    "--pele-error": "#b04a3f",
    "--pele-font": DIAGRAM_FONT_FAMILY,
    "--pele-font-mono": DIAGRAM_MONO_FONT_FAMILY,
  },
};

/**
 * Resolve the CSS variables for an app theme.
 * Unknown themes fall back to the light palette (single-theme app today).
 */
export function toPeleCssVariables(
  theme: DiagramAppTheme,
): Record<string, string> {
  return THEME_CSS_VARIABLES[theme] ?? THEME_CSS_VARIABLES.light;
}

/** Render a variable map as an inline `style` attribute value. */
export function toCssVariableStyle(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
}

type PeleErrorLike = {
  code?: unknown;
  message?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Turn an engine failure into an agent/human-readable message.
 * pelé reports `{code, line, column, snippet}` where Mermaid only had prose;
 * unsupported diagrams additionally name the types this bundle registers.
 */
export function describePeleError(error: unknown): string {
  if (!isRecord(error)) return String(error);

  const { code, message } = error as PeleErrorLike;
  const text =
    typeof message === "string" ? condensePeleMessage(message) : String(error);
  const line = peleErrorLine(error);
  const column = peleErrorColumn(error);
  const where =
    line !== undefined
      ? ` (line ${line}${column !== undefined ? `, column ${column}` : ""})`
      : "";

  if (code === "unsupported-diagram") {
    return `${text} This UI renders ${REGISTERED_DIAGRAM_TYPES.join(", ")}.`;
  }

  return `${text}${where}`;
}

/** Render a Mermaid definition to SVG markup (pelé `render` is synchronous). */
export function renderDiagramSvg(input: DiagramRenderInput): string {
  const { definition, fontFamily = DIAGRAM_FONT_FAMILY } = input;
  try {
    return render(definition, {
      fontFamily,
      fontFamilyMono: DIAGRAM_MONO_FONT_FAMILY,
    }).svg;
  } catch (error) {
    throw new Error(describePeleError(error));
  }
}

register(classDiagram, er, flowchart, sequence, state);
