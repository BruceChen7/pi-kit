<script lang="ts">
let {
  src = "",
  alt = "",
  caption = "",
}: { src?: string; alt?: string; caption?: string } = $props();
</script>

<figure class="va-image">
  <img {src} {alt} loading="lazy" />
  {#if caption}
    <figcaption>{caption}</figcaption>
  {/if}
</figure>

<style>
  .va-image {
    margin: 12px 0;
    text-align: center;
  }

  img {
    max-width: 100%;
    height: auto;
    border-radius: var(--va-radius-md);
    border: 1px solid var(--va-border-default);
  }

  figcaption {
    margin-top: 6px;
    color: var(--va-text-subtle);
    font-size: 12px;
  }
</style>
