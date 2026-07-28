<script lang="ts">
let { text = "", variant = "info" }: { text?: string; variant?: string } =
  $props();

const styles: Record<string, { bg: string; border: string; color: string }> = {
  info: {
    bg: "rgba(59, 130, 246, 0.08)",
    border: "rgba(59, 130, 246, 0.25)",
    color: "#93c5fd",
  },
  success: {
    bg: "rgba(34, 197, 94, 0.08)",
    border: "rgba(34, 197, 94, 0.25)",
    color: "#86efac",
  },
  warning: {
    bg: "rgba(234, 179, 8, 0.08)",
    border: "rgba(234, 179, 8, 0.25)",
    color: "#fde68a",
  },
  danger: {
    bg: "rgba(239, 68, 68, 0.08)",
    border: "rgba(239, 68, 68, 0.25)",
    color: "#fca5a5",
  },
};

const s = $derived(styles[variant] ?? styles.info);
</script>

<div class="va-callout" style="background: {s.bg}; border-color: {s.border}; color: {s.color};">
  {text}
</div>

<style>
  .va-callout {
    padding: 10px 14px;
    margin: 12px 0;
    border: 1px solid;
    border-radius: 7px;
    font-size: 13px;
    line-height: 1.5;
  }
</style>
