import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { Preview } from "@plurnk/plurnk-mimetypes";
import TurndownService from "turndown";

// text/html + application/xhtml+xml handler. Converts HTML to markdown via
// turndown for LLM consumption. The structural value of HTML lives in its
// rendered content, not in a separate symbol outline — so this handler
// returns a text Preview carrying the markdown body. The framework owns the
// fitting; this handler owns the orientation choice ("head" — documents read
// top-down).
//
// Web-page denoising (Readability-style filtering of nav/ads/comments) is
// intentionally out of scope here — that's a fetcher concern (plurnk-schemes-http
// when it lands), not a mimetype concern. This handler does pure HTML→md.
//
// Custom turndown rule (`safe-links`) is salvaged from rummy.web/WebFetcher:
// encode parens in hrefs as %28/%29 so URLs with literal parens don't break
// markdown's link syntax.
const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
});

turndown.addRule("safe-links", {
    filter: "a",
    replacement(content: string, node: unknown): string {
        const el = node as { getAttribute(name: string): string | null };
        const href = el.getAttribute("href");
        if (href === null) return content;
        const safeHref = href.replace(/\(/g, "%28").replace(/\)/g, "%29");
        const title = el.getAttribute("title");
        if (title !== null) return `[${content}](${safeHref} "${title}")`;
        return `[${content}](${safeHref})`;
    },
});

export default class TextHtml extends BaseHandler {
    override preview(content: string | Uint8Array): Preview {
        const html = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);
        const markdown = turndown.turndown(html);
        return { kind: "text", text: markdown, orientation: "head" };
    }
}
