<script lang="ts">
type Step = {
  title: string;
  description?: string;
  status?: "completed" | "active" | "pending";
};

let { steps = [] }: { steps?: Step[] } = $props();

const statusStyle: Record<string, { color: string; icon: string }> = {
  completed: { color: "text-olive border-olive", icon: "✓" },
  active: { color: "text-clay border-clay", icon: "●" },
  pending: { color: "text-muted-foreground border-border", icon: "○" },
};
</script>

{#if steps.length > 0}
  <div class="my-4">
    {#each steps as step, i}
      {@const ss = statusStyle[step.status ?? "pending"] ?? statusStyle.pending}
      <div class="flex gap-3 min-h-[44px]">
        <div class="flex flex-col items-center w-6 shrink-0">
          <span class="w-5 h-5 rounded-full border-2 flex items-center justify-center text-[11px] font-bold shrink-0 {ss.color}">
            {ss.icon}
          </span>
          {#if i < steps.length - 1}
            <span class="w-0.5 flex-1 my-0.5 opacity-40 bg-border"></span>
          {/if}
        </div>
        <div class="pb-3">
          <p class="text-sm font-semibold text-foreground pt-0.5">{step.title}</p>
          {#if step.description}
            <p class="text-xs text-muted-foreground leading-relaxed mt-1">{step.description}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
