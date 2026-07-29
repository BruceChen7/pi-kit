<script lang="ts">
import {
  enqueueMermaidRender,
  loadMermaidRuntime,
  type MermaidAppTheme,
  renderMermaidDiagram,
} from "./mermaid-runtime.ts";

let {
  definition = "",
  caption = "",
  height = 220,
}: { definition?: string; caption?: string; height?: number } = $props();

const instanceId = `va-mermaid-${Math.random().toString(36).slice(2, 10)}`;

let svg = $state("");
let error = $state("");
let isRendering = $state(false);
let renderVersion = 0;
let host: HTMLElement | undefined = $state();

// Single theme — always light/warm-neutral
const theme: MermaidAppTheme = "light";

async function renderCurrentDiagram(version: number): Promise<void> {
  if (!definition.trim()) {
    svg = "";
    error = "";
    return;
  }
  isRendering = true;
  error = "";
  svg = "";
  try {
    const mermaid = await loadMermaidRuntime();
    const renderedSvg = await enqueueMermaidRender(() =>
      renderMermaidDiagram(mermaid, { id: instanceId, theme, definition }),
    );
    if (version !== renderVersion) return;
    svg = renderedSvg;
  } catch (renderError) {
    if (version !== renderVersion) return;
    error =
      renderError instanceof Error
        ? renderError.message
        : "Could not render Mermaid diagram";
  } finally {
    if (version === renderVersion) isRendering = false;
  }
}

$effect(() => {
  void definition;
  renderVersion += 1;
  void renderCurrentDiagram(renderVersion);
});
</script>

<figure class="my-3 flex flex-col gap-2" bind:this={host}>
  {#if error}
    <div class="rounded-xl border border-border bg-card p-3">
      <p class="text-[#d9a84b] text-xs mb-2">Mermaid render failed. Definition shown as source:</p>
      <pre class="p-3 bg-[#141413] text-[#f0eee6] rounded-lg font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto">{definition}</pre>
      <p class="text-rust text-xs mt-2">{error}</p>
    </div>
  {:else if isRendering}
    <div class="rounded-xl border border-border bg-card flex items-center justify-center text-xs text-muted-foreground uppercase tracking-wider" style="min-height:{height}px">
      Rendering Mermaid…
    </div>
  {:else if svg}
    <div class="rounded-xl border border-border bg-card p-3">
      <div class="overflow-auto rounded-lg bg-white">{@html svg}</div>
    </div>
  {:else}
    <div class="rounded-xl border border-border bg-card flex items-center justify-center text-xs text-muted-foreground uppercase tracking-wider" style="min-height:{height}px">
      Waiting for Mermaid definition…
    </div>
  {/if}
  {#if caption}
    <figcaption class="text-sm text-muted-foreground">{caption}</figcaption>
  {/if}
</figure>
