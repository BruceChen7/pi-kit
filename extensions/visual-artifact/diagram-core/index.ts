export {
  renderArchitectureDiagram,
  validateArchitectureProps,
} from "./architecture.ts";
export { renderErDiagram, validateErProps } from "./er.ts";
export { renderLayerDiagram, validateLayerProps } from "./layer.ts";
export * from "./shared.ts";

import { validateArchitectureProps } from "./architecture.ts";
import { validateErProps } from "./er.ts";
import { validateLayerProps } from "./layer.ts";
import type { DiagramError } from "./shared.ts";

export function validateDiagramProps(
  type: "er-diagram" | "architecture-diagram" | "layer-diagram",
  props: unknown,
): DiagramError[] {
  if (type === "er-diagram") return validateErProps(props);
  if (type === "architecture-diagram") return validateArchitectureProps(props);
  return validateLayerProps(props);
}
