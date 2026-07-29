<script lang="ts">
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
    <ol class="pl-6 my-2 mb-4 text-sm text-foreground leading-relaxed space-y-1 marker:text-clay font-medium">
      {#each items as item}
        <li class="pl-1">{@html renderInlineMarkdown(itemText(item))}</li>
      {/each}
    </ol>
  {:else}
    <ul class="pl-6 my-2 mb-4 text-sm text-foreground leading-relaxed space-y-1 marker:text-clay">
      {#each items as item}
        <li class="pl-1">{@html renderInlineMarkdown(itemText(item))}</li>
      {/each}
    </ul>
  {/if}
{/if}
