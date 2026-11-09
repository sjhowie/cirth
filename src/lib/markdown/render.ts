/**
 * Markdown -> sanitized HTML. Pure apart from DOMPurify needing a DOM (browser/webview).
 *
 *  - Every block-opening token that has a source map gets `data-source-line="<0-based line>"`
 *    (used by scroll sync). Raw HTML blocks cannot carry it.
 *  - Fenced code renders as escaped `<pre><code class="language-x" data-lang="x">`; syntax
 *    highlighting is applied afterwards by highlight.ts.
 *  - Relative image sources are resolved against the Markdown file's directory and turned into
 *    asset-protocol URLs with `convertFileSrc`.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { StateCore, Token } from "markdown-it";
import { isExternalRef, resolveRelativePath, splitRef } from "./links";

export interface RenderEnv {
  /** Directory of the Markdown file; null for Untitled tabs (relative images stay unresolved). */
  docDir: string | null;
}

export const SOURCE_LINE_ATTR = "data-source-line";

/** Info strings become a CSS class and an attribute, so only a conservative character set survives. */
const LANG_RE = /^[\w+#.-]+$/;

/** URL schemes DOMPurify may keep: its defaults plus the asset protocol used for local images. */
const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** Asset-protocol URL for a local image reference, or null when it is not a relative local file. */
export function localImageUrl(docDir: string | null, src: string): string | null {
  if (isExternalRef(src)) return null;
  const { path } = splitRef(src);
  const resolved = resolveRelativePath(docDir, path);
  return resolved === null ? null : convertFileSrc(resolved);
}

function sourceLinesRule(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.map && token.type !== "inline" && token.type !== "html_block" && token.nesting >= 0) {
      token.attrSet(SOURCE_LINE_ATTR, String(token.map[0]));
    }
  }
}

function rewriteImagesRule(state: StateCore): void {
  const env = state.env as Partial<RenderEnv> | undefined;
  const docDir = env?.docDir ?? null;
  if (docDir === null) return;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    for (const child of block.children as Token[]) {
      if (child.type !== "image") continue;
      const src = child.attrGet("src");
      if (src === null) continue;
      const url = localImageUrl(docDir, String(src));
      if (url !== null) child.attrSet("src", url);
    }
  }
}

function createMarkdownIt(): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.core.ruler.push("source_lines", sourceLinesRule);
  md.core.ruler.push("local_images", rewriteImagesRule);
  md.renderer.rules.fence = (tokens, idx, _options, _env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0] ?? "";
    const attrs = self.renderAttrs(token);
    const langAttrs = LANG_RE.test(lang) ? ` class="language-${md.utils.escapeHtml(lang)}" data-lang="${md.utils.escapeHtml(lang)}"` : "";
    return `<pre${attrs}><code${langAttrs}>${md.utils.escapeHtml(token.content)}</code></pre>\n`;
  };
  return md;
}

const md = createMarkdownIt();

/** Markdown to HTML with source-line attributes. NOT sanitized: use renderMarkdown for display. */
export function renderMarkdownHtml(source: string, env: RenderEnv = { docDir: null }): string {
  return md.render(source, { ...env });
}

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // Raw <img src="rel.png"> inside HTML blocks never passes through the token rules.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element) || node.tagName !== "IMG") return;
    const docDir = currentDocDir;
    const src = node.getAttribute("src");
    if (docDir === null || src === null) return;
    const url = localImageUrl(docDir, src);
    if (url !== null) node.setAttribute("src", url);
  });
}

/** Set around each sanitize call so the (global) DOMPurify hook can see the document directory. */
let currentDocDir: string | null = null;

export function sanitizeHtml(html: string, env: RenderEnv = { docDir: null }): string {
  if (!DOMPurify.isSupported) throw new Error("HTML sanitizer unavailable: DOMPurify needs a DOM");
  installHooks();
  currentDocDir = env.docDir;
  try {
    return DOMPurify.sanitize(html, {
      ADD_ATTR: [SOURCE_LINE_ATTR],
      FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "base", "link", "meta"],
      FORBID_ATTR: ["style"],
      ALLOWED_URI_REGEXP: ALLOWED_URI,
    });
  } finally {
    currentDocDir = null;
  }
}

export function renderMarkdown(source: string, env: RenderEnv = { docDir: null }): string {
  return sanitizeHtml(renderMarkdownHtml(source, env), env);
}

/** Whether sanitization can run here (false under plain Node without a DOM). */
export function canSanitize(): boolean {
  return DOMPurify.isSupported;
}
