import { JSONPath } from "jsonpath-plus";
import { InvalidExpressionError } from "./QueryError.ts";
import type { QueryMatch } from "./types.ts";

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
        out.push({
            line: lineAtOffset(text, m.index),
            matched: shapeMatched(m),
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
            out.push({ line: i + 1, matched: lines[i] });
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
    lineFor?: (path: string, value: unknown) => number,
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
        const line = lineFor ? lineFor(r.path, r.value) : deepMinLine(r.value);
        return { line, matched: r.value, matching: r.path };
    });
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

// Outline-shape line resolver: leaves are bare numbers (= the line), parents
// are objects. For a jsonpath that returns a parent, walk inward to find the
// smallest leaf line; that's the section's "start." Used by the default
// jsonpath path in BaseHandler.
function deepMinLine(value: unknown): number {
    if (typeof value === "number") return value;
    if (value !== null && typeof value === "object") {
        let min = Number.POSITIVE_INFINITY;
        for (const v of Object.values(value as Record<string, unknown>)) {
            const candidate = deepMinLine(v);
            if (candidate < min) min = candidate;
        }
        return Number.isFinite(min) ? min : 1;
    }
    return 1;
}
