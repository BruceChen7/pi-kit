<script lang="ts">
import { renderArchitectureDiagram } from "../../../../../diagram-core.ts";
import SvgViewport from "./SvgViewport.svelte";

let {
  nodes = [],
  groups = [],
  edges = [],
  direction,
  title,
  description,
  _nodePath = "architecture-diagram",
}: {
  nodes?: unknown;
  groups?: unknown;
  edges?: unknown;
  direction?: unknown;
  title?: unknown;
  description?: unknown;
  _nodePath?: string;
} = $props();

const rendered = $derived(
  renderArchitectureDiagram(
    { nodes, groups, edges, direction, title, description },
    { idPrefix: `va-architecture-${_nodePath}` },
  ),
);
</script>

{#if rendered.ok}
  <figure class="my-3">
    <SvgViewport svg={rendered.value.svg} source={rendered.value.svg} label="Architecture diagram" />
  </figure>
{:else}
  <div class="rounded-xl border border-rust/40 bg-rust/5 p-4 text-sm text-rust">
    <strong>Architecture diagram could not be rendered.</strong>
    <ul class="mt-2 list-disc pl-5 text-xs">
      {#each rendered.errors as item}
        <li>{item.path}: {item.message}</li>
      {/each}
    </ul>
  </div>
{/if}
