import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";
import { parse } from "parse5";
import type {
    DefaultTreeAdapterMap,
} from "parse5";

// text/html + application/xhtml+xml handler. Parses with parse5 and emits
// structural symbols only — never a body slice. Per the framework's v0.5.0
// rule, the preview channel is a passive structural signal; a body slice
// (turndown'd markdown or otherwise) would teach LLM consumers to read the
// preview as content and skip the fetch.
//
// Symbols emitted (with source-position line numbers from parse5's
// sourceCodeLocationInfo):
//   - <h1>-<h6>          → heading, level from tag
//   - <title>            → heading level 1, only if no <h1> at document root
//   - <pre><code class="language-X">  → module named X
//   - <pre><code>        → module named "code"
//
// Pages with no headings, no title, and no code blocks produce an empty
// SymbolPreview — the framework fits that to an empty preview string, which
// is the correct outcome for navigation/login/empty pages.

type Element = DefaultTreeAdapterMap["element"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export default class TextHtml extends BaseHandler {
    override extractRaw(content: string | Uint8Array): MimeSymbol[] {
        const html = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);

        const doc = parse(html, { sourceCodeLocationInfo: true });
        const symbols: MimeSymbol[] = [];
        const titleSlot: { name: string; line: number } | null = collectStructural(doc, symbols);

        // If the document has a <title> but no <h1> anywhere, surface the title
        // as a level-1 heading so the page isn't dark in the radar. Real H1s
        // take precedence — duplicating them with the title would be noise.
        const hasH1 = symbols.some((s) => s.kind === "heading" && s.level === 1);
        if (titleSlot !== null && !hasH1) {
            symbols.unshift({
                name: titleSlot.name,
                kind: "heading",
                level: 1,
                line: titleSlot.line,
                endLine: titleSlot.line,
            });
        }

        return symbols;
    }
}

// Walk the parse5 tree depth-first, emitting heading and code-block symbols
// into `out` and returning the document <title> data (or null) for the
// title-as-h1 fallback.
function collectStructural(
    root: ParentNode,
    out: MimeSymbol[],
): { name: string; line: number } | null {
    let title: { name: string; line: number } | null = null;

    function walk(node: ChildNode | ParentNode): void {
        if (!isElement(node)) {
            if (hasChildNodes(node)) {
                for (const child of node.childNodes) walk(child);
            }
            return;
        }

        const tag = node.tagName;
        if (tag === "title" && title === null) {
            const text = collectText(node).trim();
            if (text.length > 0) {
                title = {
                    name: text,
                    line: node.sourceCodeLocation?.startLine ?? 1,
                };
            }
        } else if (HEADING_TAGS.has(tag)) {
            const text = collectText(node).trim();
            const loc = node.sourceCodeLocation;
            if (text.length > 0) {
                out.push({
                    name: text,
                    kind: "heading",
                    level: Number(tag[1]),
                    line: loc?.startLine ?? 1,
                    endLine: loc?.endLine ?? loc?.startLine ?? 1,
                });
            }
        } else if (tag === "pre") {
            const codeChild = findFirstElement(node, "code");
            const language = codeChild ? extractLanguage(codeChild) : "code";
            const loc = node.sourceCodeLocation;
            out.push({
                name: language,
                kind: "module",
                line: loc?.startLine ?? 1,
                endLine: loc?.endLine ?? loc?.startLine ?? 1,
            });
            return;
        }

        for (const child of node.childNodes) walk(child);
    }

    walk(root);
    return title;
}

function extractLanguage(codeEl: Element): string {
    const classAttr = codeEl.attrs.find((a) => a.name === "class");
    if (!classAttr) return "code";
    const match = classAttr.value.match(/(?:^|\s)language-(\S+)/);
    return match ? match[1] : "code";
}

function findFirstElement(parent: ParentNode, tagName: string): Element | null {
    for (const child of parent.childNodes) {
        if (isElement(child) && child.tagName === tagName) return child;
    }
    return null;
}

function collectText(node: ChildNode | ParentNode): string {
    if (isTextNode(node)) return node.value;
    if (!hasChildNodes(node)) return "";
    let out = "";
    for (const child of node.childNodes) out += collectText(child);
    return out;
}

function isElement(node: ChildNode | ParentNode): node is Element {
    return (node as Element).tagName !== undefined && (node as Element).attrs !== undefined;
}

function isTextNode(node: ChildNode | ParentNode): node is DefaultTreeAdapterMap["textNode"] {
    return (node as { nodeName?: string }).nodeName === "#text";
}

function hasChildNodes(node: unknown): node is ParentNode {
    return Array.isArray((node as { childNodes?: unknown }).childNodes);
}
