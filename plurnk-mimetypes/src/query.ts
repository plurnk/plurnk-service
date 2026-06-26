import { JSONPath } from "jsonpath-plus";
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";
import { InvalidExpressionError, QueryParseFailureError } from "./QueryError.ts";
import type { LineSpan, QueryMatch } from "./types.ts";

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
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const line = lineAtOffset(text, m.index);
        // A match containing newlines spans multiple lines.
        const endLine = line + (m[0].match(/\n/g)?.length ?? 0);
        out.push({
            matched: shapeMatched(m),
            lines: [{ line, endLine }],
        });
        // Defend against zero-length matches infinite-looping the global regex.
        if (m[0].length === 0) regex.lastIndex += 1;
    }
    return out;
}

// glob applied line-anchored against text body. Per grammar #17: each line
// that matches the glob is a separate QueryMatch; matched = the full line.
export function queryGlob(text: string, pattern: string): QueryMatch[] {
    const regex = globToRegex(pattern);
    const lines = text.split("\n");
    const out: QueryMatch[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
            out.push({ matched: lines[i], lines: [{ line: i + 1, endLine: i + 1 }] });
        }
    }
    return out;
}

// jsonpath against any JSON-shaped object (bare-leaves outline, parsed JSON
// value, parsed YAML, etc.). The `lineFor` callback maps a result back to a
// source line; when omitted (the outline case), we use the leaf-number-IS-the-
// line convention or recursively find the smallest leaf number in the result.
export function queryJsonpathObject(
    obj: unknown,
    pattern: string,
    lineFor?: (pointer: string, value: unknown) => readonly LineSpan[] | undefined,
): QueryMatch[] {
    let results: Array<{ value: unknown; path: string; pointer: string }>;
    try {
        // jsonpath-plus's overload set selects the array-return signature when
        // resultType is set, but its published types over-constrain at the
        // call site. Route through `unknown` to pick the overload we want.
        const call = JSONPath as unknown as (opts: {
            path: string;
            json: unknown;
            resultType: "all";
        }) => Array<{ value: unknown; path: string; pointer: string }>;
        results = call({ path: pattern, json: obj, resultType: "all" });
    } catch (cause) {
        throw new InvalidExpressionError({ dialect: "jsonpath", expression: pattern, cause });
    }

    return results.map((r) => {
        // A handler with source-position fidelity (JSON/JSONL via jsonc-parser)
        // supplies lineFor by pointer; otherwise resolve from the deepJson's own
        // line annotations (synthesized models) or the bare-number outline.
        const lines = (lineFor && lineFor(r.pointer, r.value)) ?? defaultLines(obj, r.pointer, r.value);
        return lines ? { matched: r.value, matching: r.path, lines } : { matched: r.value, matching: r.path };
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
export function queryXpathString(xml: string, pattern: string, mimetype: string): QueryMatch[] {
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
    return shapeXpathResult(pattern, result);
}

// Translate xpath.select result to QueryMatch[] per grammar #17. Source-line
// recovery (#13 Q1): element matches read the `pk:line` attribute the
// framework's projection wrote to every element node — that's the source-line
// the original handler's deepJson knew about. Attribute/text/comment/PI
// matches walk up to the parent element to find the same. Primitive results
// (string/number/boolean from `string(...)`, `count(...)`, etc.) fall back
// to line 1 since they have no node context.
function shapeXpathResult(pattern: string, result: xpath.SelectReturnType): QueryMatch[] {
    if (Array.isArray(result)) {
        return result.map((node, i): QueryMatch => {
            const span = spanOfMatchedNode(node);
            return {
                matched: serializeXpathNode(node),
                matching: result.length > 1 ? `(${pattern})[${i + 1}]` : undefined,
                ...(span && { lines: [span] }),
            };
        });
    }
    if (result === null || result === undefined) return [];
    // Computed scalar (string()/count()/sum()/boolean()): a value synthesized
    // from many nodes (or none) — no source node, so no `lines` (issue #41). We
    // report the value faithfully and leave the location honestly absent.
    return [{ matched: typeof result === "string" ? result : String(result) }];
}

const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;

// Recover source line from the `pk:line` attribute the framework's projection
// writes onto every element. Walks up from non-element matches (attributes,
// text nodes) to find the containing element. Falls back to 1 if nothing
// useful turns up.
function spanOfMatchedNode(node: Node): LineSpan | undefined {
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
    // element (SPEC §12.3 + #12). Absent → no span (we never fake a line, #41);
    // a projection that carries positions — including via projectJsonToXml's
    // lineFor — yields a real span, consistent with jsonpath.
    const line = pkAttr(el, "line");
    if (line === undefined) return undefined;
    return { line, endLine: pkAttr(el, "endLine") ?? line };
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

// Translate a glob pattern to an anchored regex. Supports `*`, `?`, and
// `[...]` character classes; escapes regex metacharacters elsewhere.
function globToRegex(glob: string): RegExp {
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

// Map an offset within `text` back to a 1-indexed line number.
function lineAtOffset(text: string, offset: number): number {
    let line = 1;
    const limit = Math.min(offset, text.length);
    for (let i = 0; i < limit; i += 1) {
        if (text.charCodeAt(i) === 0x0a) line += 1;
    }
    return line;
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

function explicitSpan(value: unknown): LineSpan | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const o = value as Record<string, unknown>;
    if (typeof o.line !== "number" || !(o.line > 0)) return undefined;
    const endLine = typeof o.endLine === "number" && o.endLine >= o.line ? o.endLine : o.line;
    return { line: o.line, endLine };
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
