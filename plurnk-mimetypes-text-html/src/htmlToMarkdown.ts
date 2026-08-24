import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { domToMarkdown } from "./domToMarkdown.ts";
import { wrapMarkdown } from "./wrapMarkdown.ts";

// {§mimetype-content} — one HTML-to-Markdown projection backs content(),
// regex/glob matching, and embedding. Readability extracts an article; otherwise
// the noise-stripped body supplies best-effort text. Empty/noise-only input is
// absent, and raw HTML is never a readable fallback.

export function htmlToMarkdown(html: string): string | undefined {
    if (html.trim().length === 0) return undefined;

    const { document } = parseHTML(html);
    // Whitespace/degenerate input can leave linkedom without a root element.
    if (document.documentElement === null) return undefined;

    // Readability mutates the document it walks; hand it a clone so the
    // original stays intact for the body fallback below.
    let articleHtml = new Readability(document.cloneNode(true) as Document).parse()?.content;

    // No article: remove non-reading elements before rendering the body. This is
    // content-based, not a size cap; long readable prose remains whole.
    if (articleHtml === null || articleHtml === undefined || articleHtml.trim().length === 0) {
        articleHtml = readableBody(document);
    }

    // Re-wrap in a standard shell: linkedom parks bare-fragment text outside
    // <body>, and re-parsing such a fragment elects its first element (even
    // <head>) as documentElement. The shell forces conventional placement.
    const articleDocument = parseHTML(`<html><body>${articleHtml}</body></html>`).document;
    const articleRoot = articleDocument.body ?? articleDocument.documentElement;
    let text = (articleRoot === null ? "" : domToMarkdown(articleRoot)).trim();
    // Strip any residual HTML comments and tags to ensure zero raw markup leaks into the body
    text = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "");
    const markdown = wrapMarkdown(text.trim());
    return markdown.length === 0 ? undefined : markdown;
}

// The readable body with noise removed: script/style/noscript/template carry no
// reading content but dominate app-shell byte weight — dropping them is what
// keeps serialization (and the downstream embedder) proportional to real text, not
// raw page size. Falls to the document element for unwrapped fragments.
function readableBody(document: Document): string {
    const el = document.documentElement;
    if (el === null) return "";
    // Strip from the whole element so noise is gone whether the content sits in
    // <body> or loose under <html> (linkedom parks bare fragments outside body).
    for (const node of el.querySelectorAll("script, style, noscript, template")) node.remove();
    const bodyHtml = document.body?.innerHTML ?? "";
    return bodyHtml.trim().length > 0 ? bodyHtml : el.innerHTML;
}
