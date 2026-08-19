export type RenderableNode = {
  type: string;
  props?: Record<string, unknown>;
  metadata?: { id?: string; label?: string };
};

export type RenderableCard = {
  title?: string;
  description?: string;
  nodes?: RenderableNode[];
};

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function isRenderableCard(card: RenderableCard): boolean {
  return (
    nonEmptyString(card.title) ||
    nonEmptyString(card.description) ||
    (Array.isArray(card.nodes) && card.nodes.some(isRenderableNode))
  );
}

export function isRenderableNode(node: RenderableNode): boolean {
  const props = node.props ?? {};

  switch (node.type) {
    case "code-block":
      return nonEmptyString(props.code);
    case "mermaid":
      return nonEmptyString(props.definition);
    case "er-diagram":
      return nonEmptyArray(props.entities);
    case "architecture-diagram":
      return nonEmptyArray(props.nodes);
    case "layer-diagram":
      return nonEmptyArray(props.layers);
    case "svg-diagram":
      return nonEmptyString(props.svg);
    case "text":
    case "heading":
    case "badge":
    case "blockquote":
    case "quote":
      return nonEmptyString(props.text);
    case "callout":
      return nonEmptyString(props.title) || nonEmptyString(props.text);
    case "image":
    case "video":
      return nonEmptyString(props.src);
    case "link":
      return nonEmptyString(props.text) || nonEmptyString(props.href);
    case "list":
      return nonEmptyArray(props.items);
    case "table":
      return nonEmptyArray(props.headers) || nonEmptyArray(props.rows);
    case "diff":
      return nonEmptyString(props.before) || nonEmptyString(props.after);
    case "log":
      return nonEmptyArray(props.lines);
    case "file-tree":
      return nonEmptyArray(props.items);
    case "timeline":
      return nonEmptyArray(props.events) || nonEmptyArray(props.items);
    case "step":
      return nonEmptyString(props.title) || nonEmptyString(props.description);
    case "card":
    case "section":
      return (
        nonEmptyString(props.title) ||
        nonEmptyString(props.description) ||
        (Array.isArray(props.nodes) && props.nodes.some(isRenderableNode))
      );
    case "card-grid":
      return Array.isArray(props.cards) && props.cards.some(isRenderableCard);
    case "tabs":
      return (
        Array.isArray(props.tabs) &&
        props.tabs.some(
          (tab) =>
            typeof tab === "object" &&
            tab !== null &&
            Array.isArray((tab as { nodes?: unknown }).nodes) &&
            (tab as { nodes: RenderableNode[] }).nodes.some(isRenderableNode),
        )
      );
    case "accordion":
      return (
        Array.isArray(props.items) &&
        props.items.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (nonEmptyString((item as { title?: unknown }).title) ||
              (Array.isArray((item as { nodes?: unknown }).nodes) &&
                (item as { nodes: RenderableNode[] }).nodes.some(
                  isRenderableNode,
                ))),
        )
      );
    case "divider":
      return true;
    default:
      return true;
  }
}
