<script lang="ts">
let {
  code = "",
  language = "",
  showLineNumbers = false,
}: { code?: string; language?: string; showLineNumbers?: boolean } = $props();
</script>

<CodeBlock {code} {language} {showLineNumbers} />
