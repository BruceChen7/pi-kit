<script lang="ts">
let { text = "", variant = "default" }: { text?: string; variant?: string } =
  $props();

const styles: Record<string, { bg: string; border: string; color: string }> = {
  default: { bg: "#1e293b", border: "#475569", color: "#cbd5e1" },
  success: {
    bg: "rgba(34, 197, 94, 0.1)",
    border: "rgba(34, 197, 94, 0.3)",
    color: "#86efac",
  },
  warning: {
    bg: "rgba(234, 179, 8, 0.1)",
    border: "rgba(234, 179, 8, 0.3)",
    color: "#fde68a",
  },
  danger: {
    bg: "rgba(239, 68, 68, 0.1)",
    border: "rgba(239, 68, 68, 0.3)",
    color: "#fca5a5",
  },
};

const s = $derived(styles[variant] ?? styles.default);
</script>

<span class="va-badge" style="background: {s.bg}; border-color: {s.border}; color: {s.color};">
  {text}
</span>

<style>
  .va-badge {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
</style>
