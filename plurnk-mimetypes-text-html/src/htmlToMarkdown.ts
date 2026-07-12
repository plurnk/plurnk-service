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
// When Readability finds no article (apps, forms, fragments, very short HTML)
// it returns null — we degrade to best-effort markdown of the <body> (or the
// whole document for unwrapped fragments). Never raw HTML, never a throw.

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

    if (articleHtml === null || articleHtml === undefined || articleHtml.trim().length === 0) {
        articleHtml = readableBody(document);
    }

    const markdown = turndown.turndown(articleHtml).trim();
    return markdown.length === 0 ? undefined : markdown;
}

// Best-effort source for the fallback turndown: the <body> when it carries
// content, else the whole document element (unwrapped fragments like a bare
// <form> or <div> become documentElement with an empty auto-inserted <body>).
function readableBody(document: Document): string {
    const bodyHtml = document.body?.innerHTML ?? "";
    if (bodyHtml.trim().length > 0) return bodyHtml;
    return document.documentElement?.innerHTML ?? "";
}
