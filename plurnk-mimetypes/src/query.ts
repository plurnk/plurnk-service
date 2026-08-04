import { JSONPathEnvironment, type JSONValue } from "json-p3";
import type { TextRegion } from "@plurnk/plurnk-contracts";

// json-p3's default recursion-descent cap (50 nodes visited) is a DoS guard for
// untrusted deeply-nested JSON. Our jsonpath target is deepJson — our OWN parse
// tree (§12), trusted and traversed linearly, so `$..*` over it can't amplify.
// Real parse trees run hundreds to millions of nodes (a 2-line Erlang file is
// 348), so the 50-node default breaks recursive descent on every ANTLR/tree-
// sitter handler (#523 — the regression the #490 swap's shallow fixtures missed).
// Unbounded over trusted trees is the honest bound, not a magic threshold.
const JP3 = new JSONPathEnvironment({ maxRecursionDepth: Number.MAX_SAFE_INTEGER });
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";
import { InvalidExpressionError, QueryParseFailureError } from "./QueryError.ts";
import type { LineSpan, QueryMatch } from "./types.ts";
import TextCoordinates from "./TextCoordinates.ts";

// regex against arbitrary text. Returns one QueryMatch per match. Polymorphic
// `matched` shape per grammar #17:
//   - no captures → string (the whole match)
//   - anonymous captures → readonly string[] (positional only)
//   - named captures (and mixed) → object with named keys and positional
//     "1", "2", ... keys
//
// Always runs with the global flag so we get every match. Trailing /flags
// from the matcher syntax are honored.
export function queryRegex(text: string, pattern: string, flags?: string): QueryMatch[] {
    const effective = flags ?? "";
    const withGlobal = effective.includes("g") ? effective : effective + "g";
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, withGlobal);
    } catch (cause) {
        throw new InvalidExpressionError({ dialect: "regex", expression: pattern, cause });
    }

    const out: QueryMatch[] = [];
    const coordinates = new TextCoordinates(text);
    const unicode = withGlobal.includes("u") || withGlobal.includes("v");
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const region = coordinates.enclosingRegionFromOffsets(
            m.index,
            m.index + m[0].length,
        );
        out.push({
            matched: shapeMatched(m),
            ...(region === null ? {} : { regions: [region] }),
        });
        // Defend against zero-length matches infinite-looping the global regex.
        if (m[0].length === 0) {
            regex.lastIndex = advanceStringIndex(text, regex.lastIndex, unicode);
        }
    }
    return out;
}

// ECMAScript AdvanceStringIndex. Unicode regexes advance over a complete code
// point; non-Unicode regexes intentionally retain their UTF-16 code-unit
// behavior. Advancing into a surrogate pair under /u or /v can make exec()
// revisit the same zero-width match forever.
function advanceStringIndex(text: string, index: number, unicode: boolean): number {
    if (!unicode || index + 1 >= text.length) return index + 1;
    const first = text.charCodeAt(index);
    if (first < 0xD800 || first > 0xDBFF) return index + 1;
    const second = text.charCodeAt(index + 1);
    return second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1;
}

// glob applied line-anchored against text body. Per grammar #17: each line
// that matches the glob is a separate QueryMatch; matched = the full line.
export function queryGlob(text: string, pattern: string): QueryMatch[] {
    const regex = globToRegex(pattern);
    const coordinates = new TextCoordinates(text);
    const lines = coordinates.logicalLines();
    const out: QueryMatch[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const body = text.slice(line.start, line.contentEnd);
        if (regex.test(body)) {
            const region = coordinates.regionFromOffsets(line.start, line.contentEnd);
            out.push({
                matched: body,
                ...(region === null ? {} : { regions: [region] }),
            });
        }
    }
    return out;
}

// JSONPath against any JSON-shaped object (symbol outline, parsed JSON value,
// parsed YAML, etc.). A handler may map a result directly into its readable
// text with `regionFor`; otherwise annotated trees use their own provenance.
export function queryJsonpathObject(
    obj: unknown,
    pattern: string,
    regionFor?: (pointer: string, value: unknown) => readonly TextRegion[] | undefined,
    readableText?: string,
): QueryMatch[] {
    // RFC 9535 engine.
    // Grammar-closed filters — no expression evaluator on the model-authored
    // input path (the jsonpath-plus predecessor sandboxed an eval with a CVE
    // history). Normalized paths per RFC §2.7; pointers per RFC 6901.
    let results: Array<{ value: unknown; path: string; pointer: string }>;
    try {
        // deepJson is JSON-shaped by the §12 contract; the cast is the seam.
        results = JP3.query(pattern, obj as JSONValue).nodes.map((n) => ({
            value: n.value,
            path: n.path,
            pointer: String(n.toPointer()),
        }));
    } catch (cause) {
        throw new InvalidExpressionError({ dialect: "jsonpath", expression: pattern, cause });
    }

    const coordinates = readableText === undefined
        ? undefined
        : new TextCoordinates(readableText);
    return results.map((r) => {
        const regions = regionFor?.(r.pointer, r.value)
            ?? defaultRegions(obj, r.pointer, r.value, coordinates);
        return regions === undefined
            ? { matched: r.value, matching: r.path }
            : { matched: r.value, matching: r.path, regions };
    });
}

// xpath against a string of XML — parses the XML via @xmldom/xmldom, runs the
// xpath expression via the `xpath` package's XPath 1.0 engine, shapes results
// per grammar #17. Returns:
//   - element node match  → string (serialized XML)
//   - attribute/text/comment/PI node match → string (text content)
//   - primitive result (from string()/count()/etc.) → string
//
// Used by BaseHandler.query() for the universal xpath dispatch (xpath against
// the deep-xml channel for any handler that has structural content). Per-
// handler overrides (text-html, application-xml) bypass this and dispatch
// against the real source DOM for source-position fidelity.
export function queryXpathString(
    xml: string,
    pattern: string,
    mimetype: string,
    readableText?: string,
): QueryMatch[] {
    let doc: Document;
    try {
        // The deep-xml input is framework-generated (projectJsonToXml) or a
        // handler's own serialization — a malformed document is a producer
        // bug, not a content problem. Surface non-fatal parse errors instead
        // of letting xmldom silently repair the DOM; warnings stay quiet.
        const onError = (level: string, message: string): void => {
            if (level !== "warn") throw new Error(`deep-xml parse ${level}: ${message}`);
        };
        doc = new DOMParser({ onError })
            .parseFromString(xml, "text/xml") as unknown as Document;
    } catch (cause) {
        throw new QueryParseFailureError({ mimetype, cause });
    }
    let result: xpath.SelectReturnType;
    try {
        result = xpath.select(pattern, doc as unknown as Node);
    } catch (cause) {
        throw new InvalidExpressionError({ dialect: "xpath", expression: pattern, cause });
    }
    return shapeXpathResult(pattern, result, readableText);
}

// Translate xpath.select result to QueryMatch[] per grammar #17. Source-line
// recovery (#13 Q1): element matches read the `pk:line` attribute the
// framework's projection wrote to every element node — that's the source-line
// the original handler's deepJson knew about. Attribute/text/comment/PI
// matches walk up to the parent element to find the same. Primitive results
// (string/number/boolean from `string(...)`, `count(...)`, etc.) retain only
// the authored expression because they have no node context.
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
            const region = coordinates === undefined
                ? undefined
                : regionOfMatchedNode(node, coordinates);
            return {
                matched: serializeXpathNode(node),
                matching: result.length > 1 ? `(${pattern})[${i + 1}]` : pattern,
                ...(region === undefined ? {} : { regions: [region] }),
            };
        });
    }
    if (result === null || result === undefined) return [];
    // Computed scalar (string()/count()/sum()/boolean()): a value synthesized
    // from many nodes (or none) has no source node. Report the value and retain
    // the expression as its locator without fabricating a text region.
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

// Recover a readable-text region from the `pk:*` provenance attributes the
// framework projection writes onto elements. Non-element matches walk to their
// nearest annotated element. Missing or unaddressable provenance stays absent.
function regionOfMatchedNode(
    node: Node,
    coordinates: TextCoordinates,
): TextRegion | undefined {
    let el: Element | null = null;
    if (node.nodeType === ELEMENT_NODE) {
        el = node as unknown as Element;
    } else if (node.nodeType === ATTRIBUTE_NODE) {
        el = (node as Attr).ownerElement;
    } else {
        // Walk up to the nearest element ancestor for text/comment/PI/CDATA.
        let cur: Node | null = (node as { parentNode?: Node | null }).parentNode ?? null;
        while (cur && cur.nodeType !== ELEMENT_NODE) {
            cur = (cur as { parentNode?: Node | null }).parentNode ?? null;
        }
        el = cur as unknown as Element | null;
    }
    // pk:line / pk:endLine — the source span the projection wrote onto the
    // element (SPEC §12.3 + #12). A line-less child (e.g. a bare `name:"g"`
    // field projected to <name>g</name>) carries none of its own, so walk up to
    // the nearest ancestor element that does — mirroring jsonpath's ancestorChain
    // walk in defaultLines so both dialects report the SAME enclosing span (#41).
    // Only when nothing in the chain is annotated do we honestly return no span;
    // we never fake a line.
    while (el && pkAttr(el, "line") === undefined) {
        el = parentElement(el);
    }
    if (!el) return undefined;
    const line = pkAttr(el, "line");
    if (line === undefined) return undefined;
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
        return isAddressableRegion(coordinates, region) ? region : undefined;
    }
    return coordinates.lineRegion(line, endLine) ?? undefined;
}

// Nearest ancestor ELEMENT of an element node, or null at the document root.
function parentElement(el: Element): Element | null {
    let cur: Node | null = (el as { parentNode?: Node | null }).parentNode ?? null;
    while (cur && cur.nodeType !== ELEMENT_NODE) {
        cur = (cur as { parentNode?: Node | null }).parentNode ?? null;
    }
    return cur as unknown as Element | null;
}

function pkAttr(el: Element | null, name: string): number | undefined {
    if (!el) return undefined;
    const raw = el.getAttributeNS
        ? el.getAttributeNS("https://plurnk.dev/deep-xml/1", name)
        : (el as Element & { getAttribute?: (n: string) => string | null })
            .getAttribute?.(`pk:${name}`) ?? null;
    if (raw === null || raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function serializeXpathNode(node: Node): string {
    const nt = node.nodeType;
    if (nt === ATTRIBUTE_NODE) return (node as Attr).value;
    if (nt === TEXT_NODE || nt === CDATA_SECTION_NODE) return (node as Text).data;
    if (nt === COMMENT_NODE) return (node as Comment).data;
    if (nt === PROCESSING_INSTRUCTION_NODE) return (node as ProcessingInstruction).data;
    return (node as unknown as { toString: () => string }).toString();
}

// Pick a return shape for a regex match per grammar #17's polymorphism rule.
function shapeMatched(m: RegExpExecArray): unknown {
    if (m.length === 1) return m[0]; // no captures → string
    if (m.groups) {
        // Mixed/named: keys are named-group names plus positional "1", "2", ...
        const out: Record<string, string | undefined> = { ...m.groups };
        for (let i = 1; i < m.length; i += 1) out[String(i)] = m[i];
        return out;
    }
    return m.slice(1); // anonymous captures → array
}

// Translate the {§mimetype-query} glob dialect to an anchored regex. Exported
// so consumers can reuse its exact semantics without inventing another glob
// language when they need a predicate rather than query evidence.
export function globToRegex(glob: string): RegExp {
    let pat = "^";
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === "*") {
            pat += ".*";
            i += 1;
            continue;
        }
        if (c === "?") {
            pat += ".";
            i += 1;
            continue;
        }
        if (c === "[") {
            const end = glob.indexOf("]", i);
            if (end === -1) {
                pat += "\\[";
                i += 1;
                continue;
            }
            pat += glob.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        if (".+^$|(){}\\".includes(c)) pat += "\\" + c;
        else pat += c;
        i += 1;
    }
    return new RegExp(pat + "$");
}

// Default jsonpath source-line resolver (issue #41), for deepJson that carries
// its own line annotations (synthesized models like PDF) or the bare-number
// outline. Strategy, in order:
//   1. The matched value's own span — explicit line/endLine, or for the outline
//      convention (bare numbers = lines) the min..max of its leaf numbers.
//   2. Walk up the matched node's ancestors (via the JSON pointer) to the
//      nearest one carrying explicit line/endLine — covers primitives whose
//      location lives on an enclosing node (e.g. PDF $.metadata.title → the
//      document span).
// Returns undefined when nothing in the chain is line-annotated (raw JSON with
// no annotations — handled instead by a handler-supplied lineFor).
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
): readonly TextRegion[] | undefined {
    if (coordinates === undefined) return undefined;
    const exact = explicitRegion(value);
    if (exact !== undefined && isAddressableRegion(coordinates, exact)) return [exact];
    const chain = ancestorChain(root, pointer);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const enclosing = explicitRegion(chain[index]);
        if (enclosing !== undefined && isAddressableRegion(coordinates, enclosing)) {
            return [enclosing];
        }
    }
    const lines = defaultLines(root, pointer, value);
    return lines === undefined ? undefined : regionsForSpans(coordinates, lines);
}

export function regionsForLineSpans(
    text: string,
    spans: ReadonlyArray<LineSpan>,
): TextRegion[] | undefined {
    const coordinates = new TextCoordinates(text);
    return regionsForSpans(coordinates, spans);
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

// Outline to projectJsonToXml line resolver (#41 dialect symmetry). The
// bare-number symbol outline carries no `line` fields; a leaf number is its
// line. So when a symbols-only handler projects that outline for XPath
// (BaseHandler.deepXml), this resolves each pointer to the SAME min..max leaf
// span jsonpath's spanOfValue computes, keeping both dialects in agreement.
export function outlineLineFor(root: unknown): (pointer: string) => LineSpan | undefined {
    return (pointer: string) => spanOfValue(valueAtPointer(root, pointer));
}

// Resolve a JSON Pointer (RFC 6901) to the value AT that pointer ("" → root).
function valueAtPointer(root: unknown, pointer: string): unknown {
    if (pointer === "" || pointer === "/") return root;
    const tokens = pointer.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cur: unknown = root;
    for (const tok of tokens) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[tok];
    }
    return cur;
}

function explicitSpan(value: unknown): LineSpan | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const o = value as Record<string, unknown>;
    if (typeof o.line !== "number" || !(o.line > 0)) return undefined;
    const endLine = typeof o.endLine === "number" && o.endLine >= o.line ? o.endLine : o.line;
    return { line: o.line, endLine };
}

function explicitRegion(value: unknown): TextRegion | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    const startLine = candidate.line;
    const startColumn = candidate.column;
    const endLine = candidate.endLine;
    const endColumn = candidate.endColumn;
    if (
        !Number.isSafeInteger(startLine)
        || !Number.isSafeInteger(startColumn)
        || !Number.isSafeInteger(endLine)
        || !Number.isSafeInteger(endColumn)
        || (startLine as number) < 1
        || (startColumn as number) < 1
        || (endLine as number) < 1
        || (endColumn as number) < 1
    ) {
        return undefined;
    }
    return {
        startLine: startLine as number,
        startColumn: startColumn as number,
        endLine: endLine as number,
        endColumn: endColumn as number,
    };
}

function isAddressableRegion(
    coordinates: TextCoordinates,
    region: TextRegion,
): boolean {
    try {
        const start = coordinates.offsetAtPosition(
            region.startLine,
            region.startColumn,
        );
        const end = coordinates.offsetAtPosition(
            region.endLine,
            region.endColumn,
        );
        return end >= start;
    } catch {
        return false;
    }
}

function spanOfValue(value: unknown): LineSpan | undefined {
    const explicit = explicitSpan(value);
    if (explicit) return explicit;
    // Outline convention: a bare positive number IS a line; an object of them
    // spans its min..max leaf.
    const numbers = collectLineNumbers(value);
    return numbers.length > 0 ? { line: Math.min(...numbers), endLine: Math.max(...numbers) } : undefined;
}

function collectLineNumbers(value: unknown): number[] {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return [value];
    if (value !== null && typeof value === "object") {
        const out: number[] = [];
        for (const v of Object.values(value as Record<string, unknown>)) out.push(...collectLineNumbers(v));
        return out;
    }
    return [];
}

// Resolve a JSON Pointer (RFC 6901) to the chain of ancestor values from root
// down to (but excluding) the matched leaf. Used to find the nearest enclosing
// line-annotated node for a primitive hit.
function ancestorChain(root: unknown, pointer: string): unknown[] {
    if (!pointer || pointer === "/") return [];
    const tokens = pointer.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    const chain: unknown[] = [root];
    let cur: unknown = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
        if (cur === null || typeof cur !== "object") break;
        cur = (cur as Record<string, unknown>)[tokens[i]];
        chain.push(cur);
    }
    return chain;
}
