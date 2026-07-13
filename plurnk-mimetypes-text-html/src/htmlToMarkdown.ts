import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

// The single readable-text projection backing both content() (the content
// channel) and toText() (the regex/glob query surface + the framework's
// embed-source). One implementation, so the markdown a model READs, the text
// a regex/glob body-matcher scans, and the bytes the embedder vectorizes are
// all the same denoised markdown — never raw HTML.
//
// Pipeline (SPEC §18): main-content extraction via @mozilla/readability over a
// linkedom DOM, then HTML→markdown via turndown. Readability strips nav, ads,
// and chrome and returns the article body; turndown renders it as markdown.
// When Readability finds no article (app shells, forms, fragments, very short
// HTML) the readable projection is genuinely ABSENT — return undefined. We do
// NOT degrade to markdown-of-the-whole-body: that turned a 2MB JS-shell page
// (e.g. youtube.com/watch) into 2MB of "markdown" and fed it to the embedder,
// wedging the daemon (#412). Empty content when the content is empty; raw HTML
// has exactly one destiny (article extraction) and no escape hatch downstream.

const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
});

export function htmlToMarkdown(html: string): string | undefined {
    if (html.trim().length === 0) return undefined;

    const { document } = parseHTML(html);
    // Whitespace/degenerate input can leave linkedom without a root element.
    if (document.documentElement === null) return undefined;

    let articleHtml: string | null | undefined;
    try {
        // Readability mutates the document it walks; hand it a clone so the
        // original stays intact for the body fallback below.
        articleHtml = new Readability(document.cloneNode(true) as Document).parse()?.content;
    } catch {
        // Readability is best-effort denoising — its failure is not ours.
        articleHtml = undefined;
    }

    // No article (app shells, forms, snippets) → project the READABLE TEXT, not
    // the raw DOM: strip script/style/noscript/template first, then render what
    // remains. A 2MB youtube.com/watch page is dominated by <script> JSON blobs
    // — stripped, its structural markup renders to almost nothing (#412 freeze
    // cured). A <p> of search-result prose keeps its text. The axis is
    // readable-text-vs-noise, NOT size: a genuinely long article is legitimately
    // large and stays whole. Never the raw markup, never a size cap.
    if (articleHtml === null || articleHtml === undefined || articleHtml.trim().length === 0) {
        articleHtml = readableBody(document);
    }

    const markdown = turndown.turndown(articleHtml).trim();
    return markdown.length === 0 ? undefined : markdown;
}

// The readable body with noise removed: script/style/noscript/template carry no
// reading content but dominate app-shell byte weight — dropping them is what
// keeps turndown (and the downstream embedder) proportional to real text, not
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
