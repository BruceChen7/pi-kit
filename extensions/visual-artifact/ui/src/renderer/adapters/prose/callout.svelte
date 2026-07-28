<script lang="ts">
let { text = "", variant = "info" }: { text?: string; variant?: string } =
  $props();

const styles: Record<string, { bg: string; border: string; color: string }> = {
  info: {
    bg: "var(--va-bg-info-subtle)",
    border: "var(--va-border-info-subtle)",
    color: "var(--va-accent-primary-text)",
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
    border-radius: var(--va-radius-sm);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
