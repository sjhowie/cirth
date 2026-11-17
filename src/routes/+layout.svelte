<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import AboutDialog from "#lib/components/AboutDialog.svelte";
  import ChangelogDialog from "#lib/components/ChangelogDialog.svelte";

  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
<AboutDialog />
<ChangelogDialog />
