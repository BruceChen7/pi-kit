<script lang="ts">
import { renderLayerDiagram } from "../../../../../diagram-core.ts";
import SvgViewport from "./SvgViewport.svelte";

let {
  layers = [],
  edges = [],
  direction,
  title,
  description,
  _nodePath = "layer-diagram",
}: {
  layers?: unknown;
  edges?: unknown;
  direction?: unknown;
  title?: unknown;
  description?: unknown;
  _nodePath?: string;
} = $props();

const rendered = $derived(
  renderLayerDiagram(
    { layers, edges, direction, title, description },
    { idPrefix: `va-layer-${_nodePath}` },
  ),
);
</script>

{#if rendered.ok}
  <figure class="my-3">
    <SvgViewport svg={rendered.value.svg} source={rendered.value.svg} label="Layer diagram" />
  </figure>
{:else}
  <div class="rounded-xl border border-rust/40 bg-rust/5 p-4 text-sm text-rust">
    <strong>Layer diagram could not be rendered.</strong>
    <ul class="mt-2 list-disc pl-5 text-xs">
      {#each rendered.errors as item}
        <li>{item.path}: {item.message}</li>
      {/each}
    </ul>
  </div>
{/if}
