<script lang="ts">
import type { VisualArtifactThemeOption } from "./themes.ts";

let {
  theme = "dark",
  themes = [
    { id: "dark", label: "Dark" },
    { id: "light", label: "Light" },
  ],
  onToggle,
}: {
  theme?: string;
  themes?: VisualArtifactThemeOption[];
  onToggle?: (t: string) => void;
} = $props();
</script>

<div class="va-theme-toggle" role="radiogroup" aria-label="Theme">
  {#each themes as option (option.id)}
    <button
      type="button"
      class:active={theme === option.id}
      onclick={() => onToggle?.(option.id)}
      role="radio"
      aria-checked={theme === option.id}
    >{option.label}</button>
  {/each}
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
    color: var(--va-text-inverse);
    background: var(--va-accent-primary);
  }
</style>
