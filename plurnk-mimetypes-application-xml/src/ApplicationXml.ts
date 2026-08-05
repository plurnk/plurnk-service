import {
    BaseHandler,
    InvalidExpressionError,
    QueryParseFailureError,
    regionsForLineSpans,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";

// application/xml + text/xml handler. Parses with @xmldom/xmldom and emits:
//
// Symbols (extractRaw):
//   - the root element → module, with its tag name
//   - direct children of the root that carry an `id` or `name` attribute →
//     field, named by the attribute value (preferring id over name)
//   - direct children without identifiers → field, named by tag name
//
// Deep-json ({§mimetype-channel-architecture}):
//   - { type: "document", line, endLine, children: [<root element tree>] }
//   - each element: { type: tagName, attrs: {...}, children: [...] }
//   - text content collapses to a `text` field when it's the only child;
//     mixed content keeps text nodes as { type: "#text", text } siblings
//
// Query (query, xpath dialect overridden):
//   - xpath dispatches against the parsed XML DOM directly (the xpath package
//     gives us a real XPath 1.0 engine over xmldom's DOM)
//   - jsonpath inherits BaseHandler's default — runs against deepJson via the
//     framework's pipeline
//   - regex/glob inherit the BaseHandler defaults (against raw text)
const TEXT_NODE = 3;
const ATTRIBUTE_NODE = 2;
const ELEMENT_NODE = 1;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

export default class ApplicationXml extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        const text = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);
        const doc = parseXmlSilent(text);
        if (doc === null) return [];

        const root = doc.documentElement;
        if (root === null) return [];

        const symbols: MimeSymbol[] = [
            { name: root.tagName, kind: "module", line: lineOf(root as unknown as { lineNumber?: number }) ?? 1, endLine: spanEnd(root as unknown as Element) },
        ];

        // Direct children carry the root element's name as container under
        // {§mimetype-symbol-container}; the mapping only walks one level deep.
        for (let i = 0; i < root.childNodes.length; i += 1) {
            const child = root.childNodes.item(i);
            if (child === null || child.nodeType !== ELEMENT_NODE) continue;
            const el = child as unknown as Element;
            const idAttr = el.getAttribute?.("id");
            const nameAttr = el.getAttribute?.("name");
            const name = (idAttr && idAttr.length > 0)
                ? idAttr
                : ((nameAttr && nameAttr.length > 0) ? nameAttr : el.tagName);
            symbols.push({ name, kind: "field", line: lineOf(el as unknown as { lineNumber?: number }) ?? 1, endLine: spanEnd(el), container: root.tagName });
        }

        return symbols;
    }

    // Deep-channel ({§mimetype-channel-architecture}). DOM tree with attrs
    // convention so xpath like //*[@id='x'] and //channel/item work against the
    // projected deep-xml.
    override deepJson(content: HandlerContent): unknown {
        const text = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);
        const doc = parseXmlSilent(text);
        if (doc === null) return null;
        const root = doc.documentElement;
        if (root === null) return null;
        return {
            type: "document",
            line: 1,
            endLine: spanEnd(root as unknown as Element),
            children: [elementToDeep(root as unknown as Element)],
        };
    }

    // Override xpath dispatch. The xpath package gives us a real XPath 1.0
    // engine over xmldom's DOM. Line numbers default to 1 because xmldom
    // doesn't track source positions.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "xpath") {
            const text = typeof content === "string"
                ? content
                : new TextDecoder("utf-8").decode(content);
            let doc;
            try {
                doc = new DOMParser().parseFromString(text, "text/xml");
            } catch (cause) {
                throw new QueryParseFailureError({ mimetype: this.mimetype, cause });
            }
            let result: xpath.SelectReturnType;
            try {
                result = xpath.select(pattern, doc as unknown as Node);
            } catch (cause) {
                throw new InvalidExpressionError({ dialect: "xpath", expression: pattern, cause });
            }
            return shapeXpathResult(pattern, result, text);
        }
        return super.query(content, dialect, pattern, flags);
    }
}

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;

function parseXmlSilent(text: string): XmlDocument | null {
    if (text.length === 0) return null;
    // xmldom 0.9's errorHandler is a single function (level, msg, context).
    // No-op silences both warnings and parse errors for our extraction path —
    // we want a best-effort parse, not a strict gate. Anything genuinely
    // unparseable returns a document with no documentElement and we route
    // that through the "no symbols" path upstream.
    return new DOMParser({
        errorHandler: () => undefined,
    }).parseFromString(text, "text/xml");
}

// 1-indexed source line of an xmldom node (start), or undefined.
function lineOf(node: { lineNumber?: number }): number | undefined {
    return typeof node.lineNumber === "number" && node.lineNumber > 0 ? node.lineNumber : undefined;
}

// An element's source-line span end = start line + newlines in its serialized
// form (covers the closing tag). xmldom gives per-node start lines but no end;
// the serialized extent is accurate and parser-agnostic, so jsonpath (deepJson)
// and xpath agree on the same element. Never a faked 1.
function spanEnd(el: Element): number {
    const start = lineOf(el as unknown as { lineNumber?: number }) ?? 1;
    const serialized = (el as unknown as { toString(): string }).toString();
    return start + (serialized.match(/\n/g)?.length ?? 0);
}

function elementToDeep(el: Element): Record<string, unknown> {
    const line = lineOf(el as unknown as { lineNumber?: number }) ?? 1;
    const node: Record<string, unknown> = {
        type: el.tagName,
        line,
        endLine: spanEnd(el),
    };
    if (el.attributes && el.attributes.length > 0) {
        const attrs: Record<string, string> = {};
        for (let i = 0; i < el.attributes.length; i += 1) {
            const a = el.attributes.item(i);
            if (a) attrs[a.name] = a.value;
        }
        node.attrs = attrs;
    }
    const children: unknown[] = [];
    for (let i = 0; i < el.childNodes.length; i += 1) {
        const child = el.childNodes.item(i);
        if (child === null) continue;
        if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
            const value = (child as Text).data;
            if (value.length > 0) children.push({ type: "#text", text: value });
            continue;
        }
        if (child.nodeType === ELEMENT_NODE) {
            children.push(elementToDeep(child as unknown as Element));
        }
        // Skip comments, PIs — not queryable structural content.
    }
    if (children.length === 1
        && typeof children[0] === "object"
        && children[0] !== null
        && (children[0] as { type: string }).type === "#text") {
        node.text = (children[0] as { text: string }).text;
    } else if (children.length > 0) {
        node.children = children;
    }
    return node;
}

// Translate xpath.select results per {§mimetype-query}, with real source-line
// spans from @xmldom/xmldom's node lineNumber.
function shapeXpathResult(
    pattern: string,
    result: xpath.SelectReturnType,
    content: string,
): QueryMatch[] {
    if (Array.isArray(result)) {
        return result.map((node, i): QueryMatch => {
            const line = nodeLine(node);
            // Real span (consistent with deepJson): element matches end at their
            // last descendant's line; non-elements span a single line.
            const endLine = line !== undefined && node.nodeType === ELEMENT_NODE
                ? spanEnd(node as unknown as Element)
                : line;
            const regions = line === undefined
                ? undefined
                : regionsForLineSpans(content, [{ line, endLine: endLine ?? line }]);
            return {
                matched: serializeNode(node),
                matching: result.length > 1 ? `(${pattern})[${i + 1}]` : pattern,
                ...(regions === undefined ? {} : { regions }),
            };
        });
    }
    if (result === null || result === undefined) return [];
    // Computed scalar (string()/count()/boolean()): no source node → no `lines`
    // under {§mimetype-query}. The value is reported; the location is honestly absent.
    return [{
        matched: typeof result === "string" ? result : String(result),
        matching: pattern,
    }];
}

// 1-indexed source line of a matched node from xmldom's lineNumber. Attributes
// borrow their owner element; other non-element nodes their parent.
function nodeLine(node: Node): number | undefined {
    const direct = (node as { lineNumber?: number }).lineNumber;
    if (typeof direct === "number" && direct > 0) return direct;
    const owner = (node as Attr).ownerElement
        ?? (node as { parentNode?: Node | null }).parentNode ?? null;
    const ln = (owner as { lineNumber?: number } | null)?.lineNumber;
    return typeof ln === "number" && ln > 0 ? ln : undefined;
}

function serializeNode(node: Node): string {
    const nt = node.nodeType;
    if (nt === ATTRIBUTE_NODE) return (node as Attr).value;
    if (nt === TEXT_NODE || nt === CDATA_SECTION_NODE) return (node as Text).data;
    if (nt === COMMENT_NODE) return (node as Comment).data;
    if (nt === PROCESSING_INSTRUCTION_NODE) return (node as ProcessingInstruction).data;
    return (node as unknown as { toString: () => string }).toString();
}
