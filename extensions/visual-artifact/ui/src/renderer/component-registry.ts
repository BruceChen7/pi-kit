/**
 * Component registry — maps node.type to Svelte component.
 */

import CodeBlockAdapter from "./adapters/code/code-block.svelte";
import FileTreeAdapter from "./adapters/code/file-tree.svelte";
import LogAdapter from "./adapters/code/log.svelte";
import DiffAdapter from "./adapters/data/diff.svelte";
import StatCardAdapter from "./adapters/data/stat-card.svelte";
import TableAdapter from "./adapters/data/table.svelte";
import AccordionAdapter from "./adapters/layout/accordion.svelte";
import CardAdapter from "./adapters/layout/card.svelte";
import CardGridAdapter from "./adapters/layout/card-grid.svelte";
import SectionAdapter from "./adapters/layout/section.svelte";
import TabsAdapter from "./adapters/layout/tabs.svelte";
import ImageAdapter from "./adapters/media/image.svelte";
import MermaidAdapter from "./adapters/media/mermaid.svelte";
import SvgDiagramAdapter from "./adapters/media/svg-diagram.svelte";
import VideoAdapter from "./adapters/media/video.svelte";
import BadgeAdapter from "./adapters/meta/badge.svelte";
import DividerAdapter from "./adapters/meta/divider.svelte";
import LinkAdapter from "./adapters/meta/link.svelte";
import BlockquoteAdapter from "./adapters/prose/blockquote.svelte";
import CalloutAdapter from "./adapters/prose/callout.svelte";
import HeadingAdapter from "./adapters/prose/heading.svelte";
import ListAdapter from "./adapters/prose/list.svelte";
import QuoteAdapter from "./adapters/prose/quote.svelte";
import TextAdapter from "./adapters/prose/text.svelte";
import StepAdapter from "./adapters/timeline/step.svelte";
import TimelineAdapter from "./adapters/timeline/timeline.svelte";

// biome-ignore lint/suspicious/noExplicitAny: Svelte 5 component constructor type is complex; any is safe for runtime-only registry
export type AdapterComponent = any;

const registry: Record<string, AdapterComponent> = {
  // prose
  text: TextAdapter,
  heading: HeadingAdapter,
  quote: QuoteAdapter,
  callout: CalloutAdapter,
  blockquote: BlockquoteAdapter,
  list: ListAdapter,
  // data
  table: TableAdapter,
  "stat-card": StatCardAdapter,
  diff: DiffAdapter,
  // layout
  card: CardAdapter,
  "card-grid": CardGridAdapter,
  tabs: TabsAdapter,
  accordion: AccordionAdapter,
  section: SectionAdapter,
  // media
  mermaid: MermaidAdapter,
  "svg-diagram": SvgDiagramAdapter,
  image: ImageAdapter,
  video: VideoAdapter,
  // code
  "code-block": CodeBlockAdapter,
  log: LogAdapter,
  "file-tree": FileTreeAdapter,
  // meta
  link: LinkAdapter,
  divider: DividerAdapter,
  badge: BadgeAdapter,
  // timeline
  timeline: TimelineAdapter,
  step: StepAdapter,
};

/**
 * Get the adapter component for a node type.
 * Returns undefined if the node type is not registered.
 */
export function getAdapter(type: string): AdapterComponent | undefined {
  return registry[type];
}

/**
 * Register additional adapter components.
 */
export function registerAdapter(
  type: string,
  component: AdapterComponent,
): void {
  registry[type] = component;
}
