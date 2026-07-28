<script lang="ts">
let {
  theme = "dark",
  onToggle,
}: { theme?: string; onToggle?: (t: string) => void } = $props();

function toggle(): void {
  const next = theme === "dark" ? "light" : "dark";
  onToggle?.(next);
}
</script>

<div class="va-theme-toggle" role="radiogroup" aria-label="Theme">
  <button
    type="button"
    class:active={theme === "dark"}
    onclick={() => onToggle?.("dark")}
    role="radio"
    aria-checked={theme === "dark"}
  >Dark</button>
  <button
    type="button"
    class:active={theme === "light"}
    onclick={() => onToggle?.("light")}
    role="radio"
    aria-checked={theme === "light"}
  >Light</button>
</div>

<style>
  .va-theme-toggle {
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--va-border-strong);
    border-radius: 999px;
    background: var(--va-bg-surface);
  }

  button {
    height: 26px;
    padding: 0 9px;
    color: var(--va-text-muted);
    background: transparent;
    border: 0;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
  }

  button.active {
    color: #fff;
    background: var(--va-accent-primary);
  }
</style>
