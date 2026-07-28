<script lang="ts">
let { text = "" }: { text?: string } = $props();
</script>

<blockquote class="va-blockquote">{text}</blockquote>

<style>
  .va-blockquote {
    margin: 12px 0;
    padding: 8px 14px;
    border-left: 3px solid #475569;
    color: #94a3b8;
    font-style: italic;
    line-height: 1.6;
  }
</style>
