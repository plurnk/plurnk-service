import {
    BaseHandler,
    InvalidExpressionError,
    projectDomToJson,
    queryJsonpathObject,
    serializeXpathNode,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { Node as XmlNode } from "@xmldom/xmldom";
import HtmlSource from "./HtmlSource.ts";
import * as xpath from "xpath";
import { htmlToMarkdown } from "./htmlToMarkdown.ts";
import { markdownWrapColumns } from "./wrapMarkdown.ts";

// text/html + application/xhtml+xml handler. Parses with parse5 and emits
// structural symbols.
//
// Symbols emitted (with source positions from parse5's
// sourceCodeLocationInfo — 1-indexed line/endLine/column/endColumn):
//   - <h1>-<h6>          → heading, level from tag
//   - <title>            → heading level 1, only if no <h1> at document root
//   - <pre><code class="language-X">  → module named X
//   - <pre><code>        → module named "code"
//
// Container (SPEC §3): a heading carries the dotted path of its open
// ancestor headings by level (document order, markdown-style — HTML headings
// don't nest in the DOM). Code-block modules carry the qualified path of the
// innermost open heading. Top-level symbols and the title-as-h1 fallback
// carry no container key.
//
// Pages with no headings, no title, and no code blocks produce an empty
// symbol list — the honest channel for unstructured markup.

type Element = DefaultTreeAdapterMap["element"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export default class TextHtml extends BaseHandler {
    override projectionConfiguration(): string {
        return JSON.stringify({ wrapColumns: markdownWrapColumns() });
    }

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

    override deepJson(content: HandlerContent): unknown {
        const html = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
        const source = new HtmlSource(html);
        return projectDomToJson(source.document, (node) => source.region(node)).value;
    }

    // {§mimetype-content} — project HTML into model-readable Markdown; empty or
    // noise-only input has no readable projection. Bytes decode as UTF-8. The
    // projection is the consumer's `readable` channel; regex and glob run over
    // whichever channel they address, so this handler keeps the base `toText`
    // (the raw markup) for them.
    override content(content: HandlerContent): string | undefined {
        const html = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);
        return htmlToMarkdown(html);
    }

    override async query(content: HandlerContent, dialect: QueryDialect, pattern: string, flags?: string): Promise<QueryMatch[]> {
        if (dialect !== "xpath" && dialect !== "jsonpath") return super.query(content, dialect, pattern, flags);
        const html = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
        const source = new HtmlSource(html);
        if (dialect === "jsonpath") {
            const { value, regions } = projectDomToJson(source.document, (node) => source.region(node));
            return queryJsonpathObject(value, pattern, (pointer) => regions.get(pointer));
        }
        let result: xpath.SelectReturnType;
        try { result = xpath.select(pattern, source.document as unknown as Node); }
        catch (cause) { throw new InvalidExpressionError({ dialect, expression: pattern, cause }); }
        if (!Array.isArray(result)) return result === null || result === undefined ? [] : [{ matched: String(result), matching: pattern }];
        return result.map((node, index) => {
            const region = source.region(node as unknown as XmlNode);
            return {
                matched: serializeXpathNode(node),
                matching: result.length > 1 ? "(" + pattern + ")[" + (index + 1) + "]" : pattern,
                ...(region === undefined ? {} : { regions: [region] }),
            };
        });
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
    // Open ancestor headings, markdown-style: a heading at level N closes
    // every open heading at level >= N (HTML headings don't nest in the DOM,
    // so document order + level is the containment signal). SPEC §3.
    const open: Array<{ level: number; name: string }> = [];

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
                const level = Number(tag[1]);
                while (open.length > 0 && open[open.length - 1].level >= level) {
                    open.pop();
                }
                const container = open.map((o) => o.name).join(".");
                out.push({
                    name: text,
                    kind: "heading",
                    level,
                    line: loc?.startLine ?? 1,
                    endLine: loc?.endLine ?? loc?.startLine ?? 1,
                    ...(loc && { column: loc.startCol, endColumn: loc.endCol }),
                    ...(container.length > 0 && { container }),
                });
                open.push({ level, name: text });
            }
        } else if (tag === "pre") {
            const codeChild = findFirstElement(node, "code");
            const language = codeChild ? extractLanguage(codeChild) : "code";
            const loc = node.sourceCodeLocation;
            const container = open.map((o) => o.name).join(".");
            out.push({
                name: language,
                kind: "module",
                line: loc?.startLine ?? 1,
                endLine: loc?.endLine ?? loc?.startLine ?? 1,
                ...(loc && { column: loc.startCol, endColumn: loc.endCol }),
                ...(container.length > 0 && { container }),
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
