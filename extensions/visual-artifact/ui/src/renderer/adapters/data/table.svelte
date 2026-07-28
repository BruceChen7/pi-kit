<script lang="ts">
let { headers = [], rows = [] }: { headers?: string[]; rows?: string[][] } =
  $props();
</script>

<div class="va-table-wrapper">
  <table class="va-table">
    {#if headers.length > 0}
      <thead>
        <tr>
          {#each headers as header}
            <th>{header}</th>
          {/each}
        </tr>
      </thead>
    {/if}
    <tbody>
      {#each rows as row}
        <tr>
          {#each row as cell}
            <td>{cell}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .va-table-wrapper {
    overflow-x: auto;
    margin: 12px 0;
  }

  .va-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th, td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid var(--va-border-default);
  }

  th {
    color: var(--va-text-muted);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  td {
    color: var(--va-text-secondary);
  }

  tbody tr:hover {
    background: var(--va-bg-hover);
  }
</style>
