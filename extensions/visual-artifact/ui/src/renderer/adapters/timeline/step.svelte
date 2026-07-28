<script lang="ts">
type Step = {
  title: string;
  description?: string;
  status?: "completed" | "active" | "pending";
};

let { steps = [] }: { steps?: Step[] } = $props();

const statusColors: Record<string, string> = {
  completed: "var(--va-accent-success)",
  active: "var(--va-accent-primary)",
  pending: "var(--va-border-strong)",
};

const statusIcons: Record<string, string> = {
  completed: "✓",
  active: "●",
  pending: "○",
};
</script>

{#if steps.length > 0}
  <div class="va-steps">
    {#each steps as step, i}
      {@const color = statusColors[step.status ?? "pending"] ?? "var(--va-border-strong)"}
      {@const icon = statusIcons[step.status ?? "pending"] ?? "○"}
      <div class="va-step">
        <div class="va-step-marker">
          <span class="va-step-icon" style="color: {color}; border-color: {color};">
            {icon}
          </span>
          {#if i < steps.length - 1}
            <span class="va-step-line" style="background: {color};"></span>
          {/if}
        </div>
        <div class="va-step-content">
          <p class="va-step-title">{step.title}</p>
          {#if step.description}
            <p class="va-step-desc">{step.description}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-steps {
    margin: 16px 0;
  }

  .va-step {
    display: flex;
    gap: 12px;
    min-height: 44px;
  }

  .va-step-marker {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 24px;
    flex-shrink: 0;
  }

  .va-step-icon {
    width: 22px;
    height: 22px;
    border: 2px solid;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .va-step-line {
    width: 2px;
    flex: 1;
    margin: 2px 0;
    opacity: 0.4;
  }

  .va-step-content {
    padding-bottom: 12px;
  }

  .va-step-title {
    margin: 0;
    color: var(--va-text-primary);
    font-size: 14px;
    font-weight: 600;
    padding-top: 2px;
  }

  .va-step-desc {
    margin: 4px 0 0;
    color: var(--va-text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
