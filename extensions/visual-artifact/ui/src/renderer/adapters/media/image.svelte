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
    border-radius: 8px;
    border: 1px solid #334155;
  }

  figcaption {
    margin-top: 6px;
    color: #64748b;
    font-size: 12px;
  }
</style>
