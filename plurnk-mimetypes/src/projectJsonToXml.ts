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
//   2. Within an element, the following fields become ATTRIBUTES (positional
//      metadata that's more useful at the element header than as nested
//      elements): line, endLine, column, endColumn, level. They're rendered
//      only when their value is a number or a non-empty string.
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
    "type", "text", ...ATTRIBUTE_FIELDS,
]);

export function projectJsonToXml(json: unknown, rootName = "root"): string {
    return renderValue(json, rootName);
}

function renderValue(value: unknown, elementName: string): string {
    if (value === null || value === undefined) {
        return `<${elementName}/>`;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `<${elementName}>${escapeText(String(value))}</${elementName}>`;
    }
    if (Array.isArray(value)) {
        // Top-level array (called via projectJsonToXml with array root) wraps
        // in <rootName> with repeated <item> children. Nested arrays are
        // handled inside renderObject's per-field path.
        const inner = value.map((v) => renderValue(v, "item")).join("");
        return `<${elementName}>${inner}</${elementName}>`;
    }
    if (typeof value === "object") {
        return renderObject(value as Record<string, unknown>, elementName);
    }
    return `<${elementName}/>`;
}

function renderObject(obj: Record<string, unknown>, fallbackName: string): string {
    const tag = typeof obj.type === "string" && obj.type.length > 0
        ? sanitizeElementName(obj.type)
        : fallbackName;

    let attrs = "";
    for (const key of ATTRIBUTE_FIELDS) {
        if (!(key in obj)) continue;
        const v = obj[key];
        if (v === null || v === undefined) continue;
        if (typeof v === "number" || (typeof v === "string" && v.length > 0)) {
            attrs += ` ${key}="${escapeAttr(String(v))}"`;
        }
    }

    let inner = "";
    if (typeof obj.text === "string" && obj.text.length > 0) {
        inner += escapeText(obj.text);
    }

    for (const [key, value] of Object.entries(obj)) {
        if (RESERVED_FIELDS.has(key)) continue;
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                inner += renderValue(item, key);
            }
        } else {
            inner += renderValue(value, key);
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
