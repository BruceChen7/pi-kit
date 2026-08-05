<script lang="ts">
import { renderInlineMarkdown } from "../../inline-markdown.ts";
import { listMarkerClasses } from "./list.ts";

type ListItem = string | { content?: string; text?: string; type?: string };

let { items = [], ordered }: { items?: ListItem[]; ordered?: boolean } =
  $props();

function itemText(item: ListItem): string {
  if (typeof item === "string") return item;
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
    <ol class="my-2 mb-4 {listMarkerClasses(true)} space-y-1 pl-6 text-sm leading-relaxed text-foreground marker:text-clay font-medium">
      {#each items as item}
        <li class="pl-1">{@html renderInlineMarkdown(itemText(item))}</li>
      {/each}
    </ol>
  {:else}
    <ul class="my-2 mb-4 {listMarkerClasses(false)} space-y-1 pl-6 text-sm leading-relaxed text-foreground marker:text-clay">
      {#each items as item}
        <li class="pl-1">{@html renderInlineMarkdown(itemText(item))}</li>
      {/each}
    </ul>
  {/if}
{/if}
