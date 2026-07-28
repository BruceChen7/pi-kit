<script lang="ts">
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
        <li>{itemText(item)}</li>
      {/each}
    </ol>
  {:else}
    <ul class="va-list va-list-unordered">
      {#each items as item}
        <li>{itemText(item)}</li>
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
</style>
