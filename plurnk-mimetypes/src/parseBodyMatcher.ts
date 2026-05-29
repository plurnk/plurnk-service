import type { QueryDialect } from "./types.ts";

export interface ParsedBodyMatcher {
    readonly dialect: QueryDialect;
    readonly pattern: string;
    readonly flags?: string;
}

// Dispatches a body-matcher expression to its dialect using the leading-
// prefix table from plurnk-grammar (plurnk.md §"Body matcher dispatch"):
//
//   //...       → xpath
//   /pat/flags  → regex (flags optional; escapes `\/` allowed inside pat)
//   $...        → jsonpath
//   otherwise   → glob (line-anchored body matching per grammar #17)
//
// Order matters: `//` must be tested before `/` because both start with `/`.
export function parseBodyMatcher(expr: string): ParsedBodyMatcher {
    if (expr.startsWith("//")) {
        return { dialect: "xpath", pattern: expr };
    }
    if (expr.startsWith("$")) {
        return { dialect: "jsonpath", pattern: expr };
    }
    if (expr.startsWith("/")) {
        // Strip the leading slash, then look for a trailing /flags. We allow
        // `\/` as an escape inside the pattern body to preserve literal slashes.
        const inner = expr.slice(1);
        const trailing = inner.match(/\/([gimsuy]*)$/);
        if (trailing) {
            const patternEnd = inner.length - trailing[0].length;
            return {
                dialect: "regex",
                pattern: inner.slice(0, patternEnd),
                flags: trailing[1] || undefined,
            };
        }
        // No closing slash → take the whole tail as the pattern (lenient).
        return { dialect: "regex", pattern: inner };
    }
    return { dialect: "glob", pattern: expr };
}
