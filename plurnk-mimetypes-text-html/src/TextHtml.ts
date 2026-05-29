import {
    BaseHandler,
    InvalidExpressionError,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";

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

    // Override xpath dispatch. parse5's tree isn't xpath-traversable, so we
    // re-parse via @xmldom/xmldom (which produces a real DOM that the `xpath`
    // package can walk). Line numbers default to 1 because xmldom doesn't
    // track source positions — accepting that limitation in exchange for a
    // standards-compliant XPath 1.0 engine. Models can still get the matched
    // value and a structural locator via `matching` for multi-match queries.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "xpath") {
            const html = typeof content === "string"
                ? content
                : new TextDecoder("utf-8").decode(content);

            // We parse as text/xml on purpose. Parsing as text/html or
            // application/xhtml+xml causes xmldom to put every element in the
            // XHTML namespace, which makes xpath queries without a namespace
            // prefix (the natural `//p`, `//user`, etc.) match nothing —
            // unusable from the matcher contract's perspective. text/xml
            // omits the namespace assignment, so queries work as the model
            // expects. Cost: content must be reasonably well-formed XML;
            // malformed HTML (unclosed tags, void elements written without
            // self-closing) throws QueryParseFailureError → 422.
            let doc;
            try {
                doc = new DOMParser().parseFromString(html, "text/xml");
            } catch (cause) {
                throw new QueryParseFailureError({ mimetype: this.mimetype, cause });
            }

            let result: xpath.SelectReturnType;
            try {
                result = xpath.select(pattern, doc as unknown as Node);
            } catch (cause) {
                throw new InvalidExpressionError({ dialect: "xpath", expression: pattern, cause });
            }

            return shapeXpathResult(pattern, result);
        }
        return super.query(content, dialect, pattern, flags);
    }
}

// Translate an xpath.select return value to QueryMatch[] per grammar #17.
function shapeXpathResult(pattern: string, result: xpath.SelectReturnType): QueryMatch[] {
    if (Array.isArray(result)) {
        return result.map((node, i): QueryMatch => ({
            line: 1,
            matched: serializeNode(node),
            matching: result.length > 1 ? `(${pattern})[${i + 1}]` : undefined,
        }));
    }
    if (result === null || result === undefined) return [];
    // Primitive result (string/number/boolean from a function expression like
    // string(...), count(...), boolean(...)).
    return [{ line: 1, matched: typeof result === "string" ? result : String(result) }];
}

// Convert an xpath result node to a string suitable for QueryMatch.matched.
// Per grammar #17: text/attribute → string value; element → serialized XML.
// The xpath package's .d.ts advertises type-guard helpers (xpath.isAttribute
// etc.) that aren't actually exported at runtime, so we dispatch on the
// numeric nodeType the DOM spec defines.
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
function serializeNode(node: Node): string {
    const nt = node.nodeType;
    if (nt === ATTRIBUTE_NODE) return (node as Attr).value;
    if (nt === TEXT_NODE || nt === CDATA_SECTION_NODE) return (node as Text).data;
    if (nt === COMMENT_NODE) return (node as Comment).data;
    if (nt === PROCESSING_INSTRUCTION_NODE) return (node as ProcessingInstruction).data;
    return (node as unknown as { toString: () => string }).toString();
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
