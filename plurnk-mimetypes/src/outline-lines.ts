import { isRecord, isSafeInteger, type TextRegion } from "@plurnk/plurnk-contracts";
import type { LineSpan } from "./types.ts";

// Outline-to-projectJsonToXml line resolver under the dialect symmetry in
// {§mimetype-query}. The bare-number symbol outline carries no `line` fields;
// a leaf number is its line. So when a symbols-only handler projects that
// outline for XPath (BaseHandler.deepXml), this resolves each pointer to the
// SAME min..max leaf span jsonpath's spanOfValue computes.
export function outlineLineFor(root: unknown): (pointer: string) => LineSpan | undefined {
    return (pointer: string) => spanOfValue(valueAtPointer(root, pointer));
}

// Resolve a JSON Pointer (RFC 6901) to the value AT that pointer ("" → root).
export function valueAtPointer(root: unknown, pointer: string): unknown {
    if (pointer === "") return root;
    const tokens = pointer.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cur: unknown = root;
    for (const tok of tokens) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = Reflect.get(cur, tok);
    }
    return cur;
}

export function explicitSpan(value: unknown): LineSpan | undefined {
    if (!isRecord(value)) return undefined;
    const o = value;
    if (typeof o.line !== "number" || !(o.line > 0)) return undefined;
    const endLine = typeof o.endLine === "number" && o.endLine >= o.line ? o.endLine : o.line;
    return { line: o.line, endLine };
}

export function explicitRegion(value: unknown): TextRegion | undefined {
    if (!isRecord(value)) return undefined;
    const { line: startLine, column: startColumn, endLine, endColumn } = value;
    if (
        !isSafeInteger(startLine)
        || !isSafeInteger(startColumn)
        || !isSafeInteger(endLine)
        || !isSafeInteger(endColumn)
        || startLine < 1
        || startColumn < 1
        || endLine < 1
        || endColumn < 1
    ) {
        return undefined;
    }
    return { startLine, startColumn, endLine, endColumn };
}

export function spanOfValue(value: unknown): LineSpan | undefined {
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
        for (const v of Object.values(value)) out.push(...collectLineNumbers(v));
        return out;
    }
    return [];
}

// Resolve a JSON Pointer (RFC 6901) to the chain of ancestor values from root
// down to (but excluding) the matched leaf. Used to find the nearest enclosing
// line-annotated node for a primitive hit.
export function ancestorChain(root: unknown, pointer: string): unknown[] {
    if (!pointer) return [];
    const tokens = pointer.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    const chain: unknown[] = [root];
    let cur: unknown = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
        if (cur === null || typeof cur !== "object") break;
        cur = Reflect.get(cur, tokens[i]);
        chain.push(cur);
    }
    return chain;
}
