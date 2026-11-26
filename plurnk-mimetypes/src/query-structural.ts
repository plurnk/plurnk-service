import { JSONPathEnvironment, JSONPathError, type JSONPathQuery, type JSONValue } from "json-p3";
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";
import { Validator, type TextRegion } from "@plurnk/plurnk-contracts";
import { InvalidExpressionError, QueryParseFailureError } from "./QueryError.ts";
import type { LineSpan, QueryMatch } from "./types.ts";
import TextCoordinates from "./TextCoordinates.ts";
import { PK_NS, PK_PREFIX } from "./projectJsonToXml.ts";
import { ancestorChain, explicitRegion, explicitSpan, spanOfValue } from "./outline-lines.ts";

// json-p3's default recursion-descent cap (50 nodes visited) is a DoS guard for
// untrusted deeply-nested JSON. Our jsonpath target is deepJson — our OWN parse
// tree ({§mimetype-channel-architecture}), trusted and traversed linearly, so
// `$..*` over it can't amplify.
const JP3 = new JSONPathEnvironment({ maxRecursionDepth: Number.MAX_SAFE_INTEGER });

// {§mimetype-query} — the reserved provenance prefix is bound for every xpath, so
// `//heading[@pk:level='2']` and `//*[@pk:line='5']` read as written; an unbound
// prefix stays an invalid expression.
const selectWithProvenance = xpath.useNamespaces({ [PK_PREFIX]: PK_NS });

// JSONPath against any JSON-shaped object (symbol outline, parsed JSON value,
// parsed YAML, etc.). A handler may map a result directly into its readable
// text with `regionFor`; otherwise annotated trees use their own provenance.
export function queryJsonpathObject(
    obj: unknown,
    pattern: string,
    regionFor?: (pointer: string, value: unknown) => readonly TextRegion[] | undefined,
    readableText?: string,
): QueryMatch[] {
    // {§mimetype-query}: only typed compilation failures describe an
    // invalid expression; evaluation and projection failures retain their cause.
    let query: JSONPathQuery;
    try {
        query = JP3.compile(pattern);
    } catch (cause) {
        if (!(cause instanceof JSONPathError)) throw cause;
        throw new InvalidExpressionError({ dialect: "jsonpath", expression: pattern, cause });
    }
    // {§mimetype-channel-architecture} A handler's deep JSON is JSON-shaped by contract; this is the one place its tree
    // takes json-p3's type, which names the same values structurally.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stated boundary above
    const results = query.find(obj as JSONValue).map((n) => ({
        value: n.value,
        path: n.normalizedPath(),
        pointer: String(n.pointer),
    }));

    const coordinates = readableText === undefined
        ? undefined
        : new TextCoordinates(readableText);
    return results.map((r) => {
        if (regionFor !== undefined) {
            const regions = regionFor(r.pointer, r.value);
            return { matched: r.value, matching: r.path, ...(regions === undefined ? {} : { regions }) };
        }
        return { matched: r.value, matching: r.path, ...defaultRegions(obj, r.pointer, r.value, coordinates) };
    });
}

// xpath against a string of XML — parses the XML via @xmldom/xmldom, runs the
// xpath expression via the `xpath` package's XPath 1.0 engine, shapes results
// under {§mimetype-query}.
export function queryXpathString(
    xml: string,
    pattern: string,
    mimetype: string,
    readableText?: string,
): QueryMatch[] {
    let doc: Document;
    try {
        const onError = (level: string, message: string): void => {
            if (level !== "warn") throw new Error(`deep-xml parse ${level}: ${message}`);
        };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- xmldom Document satisfies xpath Document
        doc = new DOMParser({ onError }).parseFromString(xml, "text/xml") as unknown as Document;
    } catch (cause) {
        throw new QueryParseFailureError({ mimetype, cause });
    }
    let result: xpath.SelectReturnType;
    try {
        result = selectWithProvenance(pattern, doc);
    } catch (cause) {
        throw new InvalidExpressionError({ dialect: "xpath", expression: pattern, cause });
    }
    return shapeXpathResult(pattern, result, readableText);
}

function shapeXpathResult(
    pattern: string,
    result: xpath.SelectReturnType,
    readableText: string | undefined,
): QueryMatch[] {
    const coordinates = readableText === undefined
        ? undefined
        : new TextCoordinates(readableText);
    if (Array.isArray(result)) {
        return result.map((node, i): QueryMatch => {
            const location = coordinates === undefined
                ? {}
                : regionOfMatchedNode(node, coordinates);
            return {
                matched: serializeXpathNode(node),
                matching: result.length > 1 ? `(${pattern})[${i + 1}]` : pattern,
                ...location,
            };
        });
    }
    if (result === null || result === undefined) return [];
    return [{
        matched: typeof result === "string" ? result : String(result),
        matching: pattern,
    }];
}

const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;
const isAttr = (node: Node): node is Attr => node.nodeType === ATTRIBUTE_NODE;
const isCharacterData = (node: Node): node is Text | Comment | ProcessingInstruction =>
    node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE || node.nodeType === COMMENT_NODE
    || node.nodeType === PROCESSING_INSTRUCTION_NODE;

const nearestElement = (node: Node): Element | null => {
    if (isElement(node)) return node;
    if (isAttr(node)) return node.ownerElement;
    let cur: Node | null = node.parentNode;
    while (cur !== null && !isElement(cur)) cur = cur.parentNode;
    return cur;
};

function regionOfMatchedNode(
    node: Node,
    coordinates: TextCoordinates,
): Pick<QueryMatch, "regions" | "enclosingRegions"> {
    let el = nearestElement(node);
    while (el && pkAttr(el, "line") === undefined && !el.hasAttributeNS(PK_NS, "regions")) {
        el = parentElement(el);
    }
    if (!el) return {};
    const serializedRegions = el.getAttributeNS(PK_NS, "regions");
    if (serializedRegions) {
        const parsed: unknown = JSON.parse(serializedRegions);
        if (!Array.isArray(parsed)) throw new Error("Projected source regions must be addressable text coordinates");
        const regions = parsed.map((region) => Validator.assertTextRegion(region));
        if (!regions.every((region) => isAddressableRegion(coordinates, region))) {
            throw new Error("Projected source regions must be addressable text coordinates");
        }
        return el === node ? { regions } : { enclosingRegions: regions };
    }
    const line = pkAttr(el, "line");
    if (line === undefined) return {};
    const endLine = pkAttr(el, "endLine") ?? line;
    const column = pkAttr(el, "column");
    const endColumn = pkAttr(el, "endColumn");
    if (column !== undefined && endColumn !== undefined) {
        const region = {
            startLine: line,
            startColumn: column,
            endLine,
            endColumn,
        };
        if (!isAddressableRegion(coordinates, region)) return {};
        return el === node ? { regions: [region] } : { enclosingRegions: [region] };
    }
    const region = coordinates.lineRegion(line, endLine);
    return region === null ? {} : { enclosingRegions: [region] };
}

function parentElement(el: Element): Element | null {
    let cur: Node | null = el.parentNode;
    while (cur !== null && !isElement(cur)) cur = cur.parentNode;
    return cur;
}

function pkAttr(el: Element | null, name: string): number | undefined {
    if (!el) return undefined;
    const raw = el.getAttributeNS("https://plurnk.xyz/deep-xml/1", name);
    if (raw === null || raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function serializeXpathNode(node: Node): string {
    if (isAttr(node)) return node.value;
    if (isCharacterData(node)) return node.data;
    // oxlint-disable-next-line typescript/no-base-to-string -- xmldom nodes serialize via toString()
    return node.toString();
}

function defaultLines(root: unknown, pointer: string, value: unknown): readonly LineSpan[] | undefined {
    const own = spanOfValue(value);
    if (own) return [own];
    const chain = ancestorChain(root, pointer);
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const sp = explicitSpan(chain[i]);
        if (sp) return [sp];
    }
    return undefined;
}

function defaultRegions(
    root: unknown,
    pointer: string,
    value: unknown,
    coordinates: TextCoordinates | undefined,
): Pick<QueryMatch, "regions" | "enclosingRegions"> {
    if (coordinates === undefined) return {};
    const exact = explicitRegion(value);
    if (exact !== undefined && isAddressableRegion(coordinates, exact)) return { regions: [exact] };
    const chain = ancestorChain(root, pointer);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const enclosing = explicitRegion(chain[index]);
        if (enclosing !== undefined && isAddressableRegion(coordinates, enclosing)) {
            return { enclosingRegions: [enclosing] };
        }
    }
    const lines = defaultLines(root, pointer, value);
    const enclosingRegions = lines === undefined ? undefined : regionsForSpans(coordinates, lines);
    return enclosingRegions === undefined ? {} : { enclosingRegions };
}

function regionsForSpans(
    coordinates: TextCoordinates,
    spans: ReadonlyArray<LineSpan>,
): TextRegion[] | undefined {
    const regions: TextRegion[] = [];
    for (const { line, endLine } of spans) {
        const region = coordinates.lineRegion(line, endLine);
        if (region === null) return undefined;
        regions.push(region);
    }
    return regions;
}

function isAddressableRegion(
    coordinates: TextCoordinates,
    region: TextRegion,
): boolean {
    try {
        const start = coordinates.offsetAtPosition(region.startLine, region.startColumn);
        const end = coordinates.offsetAtPosition(region.endLine, region.endColumn);
        return end >= start;
    } catch {
        return false;
    }
}
