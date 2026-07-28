<script lang="ts">
let { text = "" }: { text?: string } = $props();
</script>

<blockquote class="va-blockquote">{text}</blockquote>

<style>
  .va-blockquote {
    margin: 12px 0;
    padding: 8px 14px;
    border-left: 3px solid var(--va-border-strong);
    color: var(--va-text-muted);
    font-style: italic;
    line-height: 1.6;
  }
</style>
