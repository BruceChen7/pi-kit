<script lang="ts">
import {
  DIAGRAM_FONT_FAMILY,
  type DiagramAppTheme,
  renderDiagramSvg,
  toCssVariableStyle,
  toPeleCssVariables,
} from "./pele-runtime.ts";
import SvgViewport from "./SvgViewport.svelte";

let {
  definition = "",
  caption = "",
}: { definition?: string; caption?: string } = $props();

// Single theme — always light/warm-neutral
const theme: DiagramAppTheme = "light";

// Pelé resolves colors/fonts from these variables on an ancestor element.
const diagramStyle = toCssVariableStyle(toPeleCssVariables(theme));

let svg = $state("");
let error = $state("");

// Pelé renders synchronously, so the effect stays a straight
// "definition in → svg or error out" step (no queue, no staleness guard).
$effect(() => {
  const source = definition;
  if (!source.trim()) {
    svg = "";
    error = "";
    return;
  }

  try {
    svg = renderDiagramSvg({
      definition: source,
      theme,
      fontFamily: DIAGRAM_FONT_FAMILY,
    });
    error = "";
  } catch (renderError) {
    svg = "";
    error =
      renderError instanceof Error
        ? renderError.message
        : "Could not render Mermaid diagram";
  }
});
</script>

<figure class="my-3 flex flex-col gap-2" style={diagramStyle}>
  {#if error}
    <div class="rounded-xl border border-border bg-card p-3">
      <p class="text-amber text-xs mb-2">Mermaid render failed. Definition shown as source:</p>
      <pre class="p-3 bg-primary text-primary-foreground rounded-lg font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto">{definition}</pre>
      <p class="text-rust text-xs mt-2">{error}</p>
    </div>
  {:else if svg}
    <SvgViewport {svg} source={definition} label="Mermaid diagram" />
  {:else}
    <div class="rounded-xl border border-border bg-card flex items-center justify-center text-xs text-muted-foreground uppercase tracking-wider min-h-[20rem]">
      Waiting for Mermaid definition…
    </div>
  {/if}
  {#if caption}
    <figcaption class="text-sm text-muted-foreground">{caption}</figcaption>
  {/if}
</figure>
