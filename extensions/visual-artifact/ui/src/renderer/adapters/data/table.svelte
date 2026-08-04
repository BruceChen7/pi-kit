<script lang="ts">
import Table from "$components/Table.svelte";

let { headers = [], rows = [] }: { headers?: string[]; rows?: string[][] } =
  $props();

const minWidth = $derived(
  headers.length > 3
    ? `${Math.min(1440, Math.max(640, headers.length * 170))}px`
    : "100%",
);
</script>

<Table {minWidth}>
  {#if headers.length > 0}
    <thead>
      <tr>
        {#each headers as header}
          <th class="h-10 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground bg-muted border-b border-border">{header}</th>
        {/each}
      </tr>
    </thead>
  {/if}
  <tbody>
    {#each rows as row}
      <tr class="border-b border-border last:border-0 hover:bg-muted/50">
        {#each row as cell}
          <td class="max-w-[32rem] p-4 align-top text-foreground break-words">{cell}</td>
        {/each}
      </tr>
    {/each}
  </tbody>
</Table>
