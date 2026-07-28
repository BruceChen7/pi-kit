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
    color: #60a5fa;
    text-decoration: none;
    font-size: 13px;
  }

  .va-link:hover {
    text-decoration: underline;
    color: #93c5fd;
  }

  .va-link-text {
    color: #e2e8f0;
    cursor: default;
  }

  .va-link-text:hover {
    text-decoration: none;
  }
</style>
