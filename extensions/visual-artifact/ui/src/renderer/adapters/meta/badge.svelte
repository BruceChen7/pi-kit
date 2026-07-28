<script lang="ts">
let { text = "", variant = "default" }: { text?: string; variant?: string } =
  $props();

const styles: Record<string, { bg: string; border: string; color: string }> = {
  default: {
    bg: "var(--va-bg-surface)",
    border: "var(--va-border-strong)",
    color: "var(--va-text-secondary)",
  },
  success: {
    bg: "var(--va-bg-success-subtle)",
    border: "var(--va-border-success-subtle)",
    color: "var(--va-accent-success-text)",
  },
  warning: {
    bg: "var(--va-bg-warning-subtle)",
    border: "var(--va-border-warning-subtle)",
    color: "var(--va-accent-warning-text)",
  },
  danger: {
    bg: "var(--va-bg-danger-subtle)",
    border: "var(--va-border-danger-subtle)",
    color: "var(--va-accent-danger-text)",
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
