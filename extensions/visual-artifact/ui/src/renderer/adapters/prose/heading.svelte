<script lang="ts">
let { text = "", level = "h2" }: { text?: string; level?: string } = $props();

const sizes: Record<string, string> = {
  h1: "24px",
  h2: "20px",
  h3: "16px",
  h4: "14px",
};
</script>

{#if level === "h1"}
  <h1 class="va-heading">{text}</h1>
{:else if level === "h2"}
  <h2 class="va-heading">{text}</h2>
{:else if level === "h3"}
  <h3 class="va-heading">{text}</h3>
{:else if level === "h4"}
  <h4 class="va-heading">{text}</h4>
{:else}
  <h2 class="va-heading">{text}</h2>
{/if}

<style>
  .va-heading {
    margin: 20px 0 8px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--va-text-primary);
  }

  h1.va-heading { font-size: 24px; }
  h2.va-heading { font-size: 20px; }
  h3.va-heading { font-size: 16px; }
  h4.va-heading { font-size: 14px; }
</style>
