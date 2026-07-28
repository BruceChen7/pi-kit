<script lang="ts">
import { onMount } from "svelte";
import {
  enqueueMermaidRender,
  loadMermaidRuntime,
  type MermaidAppTheme,
  renderMermaidDiagram,
} from "./mermaid-runtime.ts";

let {
  definition = "",
  caption = "",
  height = 420,
}: {
  definition?: string;
  caption?: string;
  height?: number;
} = $props();

const instanceId = `visual-artifact-mermaid-${Math.random().toString(36).slice(2, 10)}`;

let svg = $state("");
let error = $state("");
let isRendering = $state(false);
let theme = $state<MermaidAppTheme>("dark");
let renderVersion = 0;
let host: HTMLElement | undefined = $state();

function readThemeFromDom(): MermaidAppTheme {
  const root =
    host?.closest("[data-theme]") ?? document.querySelector("[data-theme]");
  return root?.getAttribute("data-theme") ?? "dark";
}

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
      renderMermaidDiagram(mermaid, {
        id: instanceId,
        theme,
        definition,
      }),
    );

    if (version !== renderVersion) {
      return;
    }

    svg = renderedSvg;
  } catch (renderError) {
    if (version !== renderVersion) {
      return;
    }

    error =
      renderError instanceof Error
        ? renderError.message
        : "Could not render Mermaid diagram";
  } finally {
    if (version === renderVersion) {
      isRendering = false;
    }
  }
}

onMount(() => {
  theme = readThemeFromDom();

  const root =
    host?.closest("[data-theme]") ?? document.querySelector("[data-theme]");
  const observer = root
    ? new MutationObserver(() => {
        const nextTheme = readThemeFromDom();
        if (nextTheme !== theme) {
          theme = nextTheme;
        }
      })
    : null;

  observer?.observe(root as Node, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return () => observer?.disconnect();
});

$effect(() => {
  void definition;
  void theme;
  renderVersion += 1;
  void renderCurrentDiagram(renderVersion);
});
</script>

<figure class="va-mermaid" bind:this={host}>
  {#if error}
    <div class="va-mermaid-error">
      <p class="va-mermaid-notice">Mermaid render failed. Definition shown as source:</p>
      <pre class="va-mermaid-source">{definition}</pre>
      <p class="va-mermaid-error-text">{error}</p>
    </div>
  {:else if isRendering}
    <div class="va-mermaid-loading" style={`min-height: ${height}px`}>
      <p>Rendering Mermaid…</p>
    </div>
  {:else if svg}
    <div class="va-mermaid-frame" style={`min-height: ${height}px`}>
      <div class="va-mermaid-svg">{@html svg}</div>
    </div>
  {:else}
    <div class="va-mermaid-loading" style={`min-height: ${height}px`}>
      <p>Waiting for Mermaid definition…</p>
    </div>
  {/if}

  {#if caption}
    <figcaption class="va-mermaid-caption">{caption}</figcaption>
  {/if}
</figure>

<style>
  .va-mermaid {
    margin: 12px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .va-mermaid-frame,
  .va-mermaid-error,
  .va-mermaid-loading {
    padding: 12px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    background: var(--va-bg-surface);
  }

  .va-mermaid-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--va-text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .va-mermaid-svg {
    overflow: auto;
    border-radius: 6px;
    border: 1px solid var(--va-border-default);
    background: var(--va-bg-app);
  }

  .va-mermaid-svg :global(svg) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
    background: transparent;
  }

  .va-mermaid-notice {
    margin: 0 0 8px;
    color: var(--va-accent-warning);
    font-size: 12px;
  }

  .va-mermaid-source {
    margin: 0;
    padding: 10px;
    background: var(--va-bg-code);
    border-radius: 6px;
    font-family: var(--va-font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--va-text-secondary);
    white-space: pre-wrap;
    overflow-x: auto;
  }

  .va-mermaid-error-text {
    margin: 8px 0 0;
    color: var(--va-accent-danger-text);
    font-size: 12px;
  }

  .va-mermaid-caption {
    color: var(--va-text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
