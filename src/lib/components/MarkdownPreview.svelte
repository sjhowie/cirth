<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { getActiveText, getView, onEditorUpdate } from "$lib/editorHost.svelte";
  import { openPath } from "$lib/files";
  import { isTauri } from "$lib/ipc";
  import { highlightBlocks } from "$lib/markdown/highlight";
  import { isExternalRef, resolveRelativePath, slugify, splitRef } from "$lib/markdown/links";
  import { renderMarkdown } from "$lib/markdown/render";
  import {
    collectAnchors,
    ECHO_MS,
    editorEndLine,
    editorTopLine,
    lineToTop,
    scrollEditorToLine,
    topToLine,
    type Anchor,
  } from "$lib/markdown/scrollSync";
  import "$lib/markdown/preview.css";
  import { notifyInfo, reportError } from "$lib/notifications.svelte";
  import { dirname } from "$lib/paths";
  import { tabsStore } from "$lib/tabs.svelte";

  const DEBOUNCE_MS = 150;
  const DEBOUNCE_LIGHT_MS = 500;

  let scroller: HTMLDivElement;
  let content: HTMLDivElement;
  let anchors: Anchor[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let ignoreEditorUntil = 0;
  let ignorePreviewUntil = 0;

  function docDir(): string | null {
    const path = tabsStore.active?.path ?? null;
    // Asset-protocol URLs only exist inside Tauri; elsewhere relative images stay as written.
    return path !== null && isTauri() ? dirname(path) : null;
  }

  function previewMax(): number {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function getAnchors(): Anchor[] {
    anchors ??= collectAnchors(scroller, content);
    return anchors;
  }

  function render(): void {
    if (!tabsStore.active) return;
    const keepTop = scroller.scrollTop;
    try {
      content.innerHTML = renderMarkdown(getActiveText() ?? "", { docDir: docDir() });
    } catch (e) {
      reportError("Render Markdown preview", e);
      return;
    }
    anchors = null;
    ignorePreviewUntil = performance.now() + ECHO_MS;
    scroller.scrollTop = keepTop;
    highlightBlocks(content).catch((e: unknown) => reportError("Highlight code blocks", e));
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    const delay = tabsStore.active?.largeFile ? DEBOUNCE_LIGHT_MS : DEBOUNCE_MS;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, delay);
  }

  function syncFromEditor(): void {
    const view = getView();
    if (!view) return;
    ignorePreviewUntil = performance.now() + ECHO_MS;
    scroller.scrollTop = lineToTop(getAnchors(), editorTopLine(view), editorEndLine(view), previewMax());
  }

  function onEditorScroll(): void {
    if (performance.now() < ignoreEditorUntil) return;
    syncFromEditor();
  }

  function onPreviewScroll(): void {
    if (performance.now() < ignorePreviewUntil) return;
    const view = getView();
    if (!view) return;
    const line = topToLine(getAnchors(), scroller.scrollTop, editorEndLine(view), previewMax());
    ignoreEditorUntil = performance.now() + ECHO_MS;
    scrollEditorToLine(view, line);
  }

  function scrollToHeading(hash: string): void {
    let wanted = hash;
    try {
      wanted = decodeURIComponent(hash);
    } catch {
      // Malformed escape: compare against the literal text.
    }
    const slug = slugify(wanted);
    for (const h of content.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
      if (slugify(h.textContent ?? "") === slug) {
        scroller.scrollTop += h.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        return;
      }
    }
    notifyInfo(`No heading "${wanted}" in this document`);
  }

  async function followLink(href: string): Promise<void> {
    if (href.startsWith("#")) {
      scrollToHeading(href.slice(1));
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      await openUrl(href);
      return;
    }
    if (isExternalRef(href)) return; // other schemes are never opened
    const { path, hash } = splitRef(href);
    if (path === "") {
      if (hash) scrollToHeading(hash);
      return;
    }
    const resolved = resolveRelativePath(tabsStore.active?.path ? dirname(tabsStore.active.path) : null, path);
    if (resolved === null) {
      notifyInfo("Save the file first: relative links resolve against its folder");
      return;
    }
    await openPath(resolved);
  }

  function onClick(e: MouseEvent): void {
    const anchor = e.target instanceof Element ? e.target.closest("a") : null;
    if (!anchor || !content.contains(anchor)) return;
    e.preventDefault(); // never navigate the webview
    const href = anchor.getAttribute("href");
    if (href === null) return;
    followLink(href).catch((err: unknown) => reportError(`Open link ${href}`, err));
  }

  function onAuxClick(e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest("a")) e.preventDefault();
  }

  // Tab switch, Save As (new directory) and light-mode changes re-render at once.
  $effect(() => {
    const tab = tabsStore.active;
    if (!tab) return;
    void [tab.id, tab.path, tab.largeFile];
    untrack(() => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      render();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        syncFromEditor();
      });
    });
  });

  onMount(() => {
    const view = getView();
    view?.scrollDOM.addEventListener("scroll", onEditorScroll, { passive: true });
    const offUpdate = onEditorUpdate((u) => {
      if (u.docChanged) schedule();
    });
    const resizeObserver = new ResizeObserver(() => {
      anchors = null;
    });
    resizeObserver.observe(content);
    return () => {
      view?.scrollDOM.removeEventListener("scroll", onEditorScroll);
      offUpdate();
      resizeObserver.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="md-scroll" bind:this={scroller} onscroll={onPreviewScroll} onclick={onClick} onauxclick={onAuxClick}>
  <div class="md-preview" bind:this={content}></div>
</div>
