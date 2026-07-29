<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import { renderInlineMarkdown } from "../../inline-markdown.ts";

type ListItem =
  | string
  | {
      content?: string;
      text?: string;
      type?: string;
    };

let {
  items = [],
  ordered,
}: {
  items?: ListItem[];
  ordered?: boolean;
} = $props();

function itemText(item: ListItem): string {
  if (typeof item === "string") {
    return item;
  }
  return item.content ?? item.text ?? "";
}

const isOrdered = $derived(
  ordered ??
    items.some(
      (item) =>
        typeof item !== "string" &&
        (item.type === "number" || item.type === "ordered"),
    ),
);
</script>

{#if items.length > 0}
  {#if isOrdered}
    <ol class="va-list va-list-ordered">
      {#each items as item}
        <li>{@html renderInlineMarkdown(itemText(item))}</li>
      {/each}
    </ol>
  {:else}
    <ul class="va-list va-list-unordered">
      {#each items as item}
        <li>{@html renderInlineMarkdown(itemText(item))}</li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .va-list {
    margin: 8px 0 16px;
    padding-left: 24px;
    color: var(--va-text-secondary);
    font-size: 15px;
    line-height: 1.65;
  }

  .va-list li {
    padding-left: 4px;
    margin: 5px 0;
    white-space: pre-wrap;
  }

  .va-list li::marker {
    color: var(--va-accent-primary-text);
    font-weight: 600;
  }

  .va-list :global(code) {
    padding: 0.1em 0.34em;
    border: 1px solid var(--va-border-default);
    border-radius: 4px;
    background: var(--va-bg-code);
    color: var(--va-accent-primary-text);
    font-family: var(--va-font-mono);
    font-size: 0.88em;
  }

  .va-list :global(strong) {
    color: var(--va-text-primary);
    font-weight: 700;
  }
</style>
