// Project a deep-json structural tree to a deep-xml string per the framework's
// fixed convention. The two views must stay congruent — same conceptual tree,
// different syntax — so the model can write either jsonpath or xpath against
// the same entry and get matching reach.
//
// The rules (in priority order):
//
//   1. A JSON object whose `type` field is a non-empty string becomes an
//      element named after that type. Otherwise, the element name comes from
//      the parent key (when projecting an object inside another object) or
//      from the optional `rootName` at the document root.
//
//   2. Within an element, the following fields become ATTRIBUTES under the
//      reserved `pk:` namespace (positional bookkeeping that's more useful at
//      the element header than as nested elements): line, endLine, column,
//      endColumn, level. They render as `pk:line`, `pk:endLine`, etc. The
//      root element carries `xmlns:pk="https://plurnk.dev/deep-xml/1"` so the
//      namespace declaration scopes the whole document.
//
//      Why namespaced: per issue #12, source content's own attributes can
//      collide with bookkeeping (e.g. HTML with `<foo line="5">` content
//      yielded duplicate `line` attrs → invalid XML). Namespacing makes the
//      framework's bookkeeping always distinguishable from content attrs,
//      keeps the XML valid, and lets consumers strip it cleanly via
//      `removeAttributeNS` or a regex on the `pk:` prefix without touching
//      legitimate content attrs.
//
//   2b. An `attrs` field whose value is an object renders its entries as
//       additional XML attributes in the default namespace (no prefix). Used
//       by HTML/XML handlers where the source algebra has its own attribute
//       concept that the model writes xpath against (`//a[@href]`,
//       `//div[@class='nav']`). Attribute values that aren't
//       string/number/boolean primitives are skipped.
//
//   3. The `text` field on a leaf-shaped node becomes the element's text
//      content. Used for tree-sitter terminal nodes (identifiers, literals).
//      If both `text` and `children` are present, both are emitted: text
//      content first, then child elements.
//
//   4. Other object fields become CHILD ELEMENTS named after their key. A
//      field whose value is an array of primitives expands to repeated
//      sibling elements (the parent key supplies the element name). A field
//      whose value is an array of objects also expands to repeated sibling
//      elements, but each child's element name is determined by rule (1) —
//      its own `type` field wins over the parent key, falling back to the
//      parent key when no type is present.
//
//   5. Primitive values (string, number, boolean) inside an array of primitives
//      render as element text. `null` and `undefined` values are skipped.
//
//   6. Inputs that aren't objects at the root (top-level array or primitive)
//      are wrapped in a single `<root>` element.
//
// Example:
//   { type: "function_definition", line: 5, endLine: 10,
//     name: "greet", params: ["x", "y"] }
// →
//   <function_definition line="5" endLine="10">
//     <name>greet</name>
//     <params>x</params>
//     <params>y</params>
//   </function_definition>

const ATTRIBUTE_FIELDS = new Set([
    "line", "endLine", "column", "endColumn", "level",
]);

const RESERVED_FIELDS = new Set([
    "type", "text", "attrs", ...ATTRIBUTE_FIELDS,
]);

// Namespace prefix and URI for framework-emitted bookkeeping attributes.
// Declared on the root element only; scopes the whole document.
const PK_PREFIX = "pk";
const PK_NS = "https://plurnk.dev/deep-xml/1";

// Optional source-line resolver (issue #41): for deepJson whose nodes carry no
// `line` of their own (raw parsed JSON/INI/etc.), the handler supplies a
// resolver keyed by JSON pointer, so xpath-over-deepXml gets the SAME real lines
// as jsonpath — both dialects agree. A node's own `line` field still wins.
export type ProjectLineFor = (pointer: string) => { line: number; endLine: number } | undefined;

export function projectJsonToXml(json: unknown, rootName = "root", lineFor?: ProjectLineFor): string {
    return renderValue(json, rootName, "", lineFor, /*isRoot*/ true);
}

// JSON Pointer token escape (RFC 6901).
function ptrKey(k: string): string {
    return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

// pk:line/pk:endLine from a resolver span — only when the node carries none.
function resolvedLineAttrs(lineFor: ProjectLineFor | undefined, pointer: string): string {
    const span = lineFor?.(pointer);
    return span ? ` ${PK_PREFIX}:line="${span.line}" ${PK_PREFIX}:endLine="${span.endLine}"` : "";
}

function renderValue(value: unknown, elementName: string, pointer: string, lineFor: ProjectLineFor | undefined, isRoot = false): string {
    const ns = isRoot ? ` xmlns:${PK_PREFIX}="${PK_NS}"` : "";
    if (value === null || value === undefined) {
        return `<${elementName}${ns}/>`;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `<${elementName}${ns}${resolvedLineAttrs(lineFor, pointer)}>${escapeText(String(value))}</${elementName}>`;
    }
    if (Array.isArray(value)) {
        const inner = value.map((v, i) => renderValue(v, "item", `${pointer}/${i}`, lineFor, false)).join("");
        return `<${elementName}${ns}>${inner}</${elementName}>`;
    }
    if (typeof value === "object") {
        return renderObject(value as Record<string, unknown>, elementName, pointer, lineFor, isRoot);
    }
    return `<${elementName}${ns}/>`;
}

function renderObject(obj: Record<string, unknown>, fallbackName: string, pointer: string, lineFor: ProjectLineFor | undefined, isRoot = false): string {
    const tag = typeof obj.type === "string" && obj.type.length > 0
        ? sanitizeElementName(obj.type)
        : fallbackName;

    // Root element declares the pk: namespace once; it scopes the document.
    let attrs = isRoot ? ` xmlns:${PK_PREFIX}="${PK_NS}"` : "";

    // Framework bookkeeping (line/endLine/column/endColumn/level) → pk:-prefixed
    // to avoid collision with content's own attributes of the same name.
    let hasOwnLine = false;
    for (const key of ATTRIBUTE_FIELDS) {
        if (!(key in obj)) continue;
        const v = obj[key];
        if (v === null || v === undefined) continue;
        if (typeof v === "number" || (typeof v === "string" && v.length > 0)) {
            attrs += ` ${PK_PREFIX}:${key}="${escapeAttr(String(v))}"`;
            if (key === "line") hasOwnLine = true;
        }
    }
    // Node carries no line of its own → take it from the resolver (#41).
    if (!hasOwnLine) attrs += resolvedLineAttrs(lineFor, pointer);
    // Additional attrs from the optional `attrs` object — HTML/XML
    // convention for source-algebra attributes. Rendered in the default
    // namespace (no prefix), so consumers' xpath like `//a[@href]` keeps
    // working naturally and is structurally distinguishable from
    // framework bookkeeping.
    const extraAttrs = obj.attrs;
    if (extraAttrs !== null && typeof extraAttrs === "object" && !Array.isArray(extraAttrs)) {
        for (const [k, v] of Object.entries(extraAttrs as Record<string, unknown>)) {
            if (v === null || v === undefined) continue;
            if (typeof v === "number" || typeof v === "boolean"
                || (typeof v === "string" && v.length > 0)) {
                attrs += ` ${sanitizeElementName(k)}="${escapeAttr(String(v))}"`;
            }
        }
    }

    let inner = "";
    if (typeof obj.text === "string" && obj.text.length > 0) {
        inner += escapeText(obj.text);
    }

    for (const [key, value] of Object.entries(obj)) {
        if (RESERVED_FIELDS.has(key)) continue;
        if (value === null || value === undefined) continue;
        const childPtr = `${pointer}/${ptrKey(key)}`;
        if (Array.isArray(value)) {
            value.forEach((item, i) => {
                inner += renderValue(item, key, `${childPtr}/${i}`, lineFor);
            });
        } else {
            inner += renderValue(value, key, childPtr, lineFor);
        }
    }

    if (inner.length === 0) return `<${tag}${attrs}/>`;
    return `<${tag}${attrs}>${inner}</${tag}>`;
}

// XML element names must start with a letter/underscore and contain only
// letters, digits, hyphens, underscores, periods. Replace anything else with
// underscore; prepend underscore if the first char is invalid. This keeps
// tree-sitter node types like `function_definition` and `string_literal`
// valid as-is, while sanitizing edge cases.
function sanitizeElementName(name: string): string {
    if (name.length === 0) return "node";
    let out = "";
    const first = name.charCodeAt(0);
    if (isNameStart(first)) {
        out += name[0];
    } else {
        out += "_";
    }
    for (let i = 1; i < name.length; i += 1) {
        const c = name.charCodeAt(i);
        if (isNameChar(c)) {
            out += name[i];
        } else {
            out += "_";
        }
    }
    return out;
}

function isNameStart(c: number): boolean {
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

function isNameChar(c: number): boolean {
    return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e;
}

function escapeText(text: string): string {
    let out = "";
    for (const c of text) {
        if (c === "&") out += "&amp;";
        else if (c === "<") out += "&lt;";
        else if (c === ">") out += "&gt;";
        else out += c;
    }
    return out;
}

function escapeAttr(text: string): string {
    let out = "";
    for (const c of text) {
        if (c === "&") out += "&amp;";
        else if (c === "<") out += "&lt;";
        else if (c === '"') out += "&quot;";
        else out += c;
    }
    return out;
}
