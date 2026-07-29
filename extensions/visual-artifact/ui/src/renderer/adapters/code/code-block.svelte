<script lang="ts">
import CodeBlock from "$components/CodeBlock.svelte";

let {
  code = "",
  language = "",
  showLineNumbers = false,
}: { code?: string; language?: string; showLineNumbers?: boolean } = $props();
</script>

<CodeBlock {code} {language} {showLineNumbers} />
