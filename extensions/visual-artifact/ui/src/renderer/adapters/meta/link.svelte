<script lang="ts">
let { text = "", href = "" }: { text?: string; href?: string } = $props();
</script>

{#if href}
  <a class="va-link" {href} target="_blank" rel="noopener noreferrer">
    {text || href}
  </a>
{:else}
  <span class="va-link va-link-text">{text}</span>
{/if}

<style>
  .va-link {
    color: var(--va-accent-primary-text);
    text-decoration: none;
    font-size: 13px;
  }

  .va-link:hover {
    text-decoration: underline;
    color: var(--va-accent-primary);
  }

  .va-link-text {
    color: var(--va-text-secondary);
    cursor: default;
  }

  .va-link-text:hover {
    text-decoration: none;
  }
</style>
