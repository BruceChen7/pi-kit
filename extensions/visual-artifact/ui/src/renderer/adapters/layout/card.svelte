<script lang="ts">
let {
  title = "",
  description = "",
  nodes = [],
  _nodePath = "",
}: {
  title?: string;
  description?: string;
  nodes?: { type: string; props: Record<string, unknown> }[];
  _nodePath?: string;
} = $props();

function semanticVariant(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "good":
      return "success";
    case "bad":
      return "danger";
    case "ugly":
      return "warning";
    case "questions":
      return "info";
    default:
      return "default";
  }
}

const tone = $derived(semanticVariant(title));
</script>

<Card {tone}>
  {#if title}
    <h3 class="font-serif text-lg font-medium tracking-[-0.015em] text-foreground mb-1">{title}</h3>
  {/if}
  {#if description}
    <p class="text-sm text-muted-foreground mb-3">{description}</p>
  {/if}
  {#if nodes.length > 0}
    <div class="pt-1">
      <VisualArtifactRenderer {nodes} basePath={`${_nodePath}.props.nodes`} />
    </div>
  {/if}
</Card>
