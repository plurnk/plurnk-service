import type { QueryDialect } from "./types.ts";
import { InvalidExpressionError } from "./QueryError.ts";

export interface ParsedBodyMatcher {
    readonly dialect: QueryDialect;
    readonly pattern: string;
    readonly flags?: string;
}

// Dispatches a body-matcher expression to its dialect using the leading-
// prefix table from plurnk-contracts (plurnk.md "Pattern Filtering"):
//
//   //...       → xpath
//   /pat/flags  → regex (flags optional; escapes `\/` allowed inside pat)
//   $...        → jsonpath
//   otherwise   → glob (line-anchored body matching under {§mimetype-query})
//
// Order matters: `//` must be tested before `/` because both start with `/`.
export function parseBodyMatcher(expr: string): ParsedBodyMatcher {
    if (/[\r\n]/u.test(expr)) {
        if (expr.startsWith("/") && !expr.startsWith("//") && /(?<!\\)\/[dgimsuvy]*$/u.test(expr)) {
            const close = expr.lastIndexOf("/");
            const pattern = expr.slice(1, close);
            const flags = expr.slice(close + 1);
            try {
                new RegExp(pattern, flags);
                return { dialect: "regex", pattern, flags: flags || undefined };
            } catch {
                // Fall through to multiline literal glob
            }
        }
        return { dialect: "glob", pattern: expr };
    }
    if (expr.startsWith("//")) {
        return { dialect: "xpath", pattern: expr };
    }
    if (expr.startsWith("$")) {
        return { dialect: "jsonpath", pattern: expr };
    }
    if (expr.startsWith("/")) {
        let end = 1;
        let inClass = false;
        while (end < expr.length) {
            if (expr[end] === "\\") {
                end += 2;
                continue;
            }
            if (expr[end] === "[") {
                inClass = true;
                end++;
                continue;
            }
            if (expr[end] === "]" && inClass) {
                inClass = false;
                end++;
                continue;
            }
            if (expr[end] === "/" && !inClass) break;
            end++;
        }
        if (end >= expr.length) {
            throw new InvalidExpressionError({
                dialect: "regex",
                expression: expr,
                cause: new SyntaxError("missing closing slash"),
            });
        }
        const pattern = expr.slice(1, end);
        const flags = expr.slice(end + 1);
        try {
            new RegExp(pattern, flags);
        } catch (cause) {
            throw new InvalidExpressionError({ dialect: "regex", expression: expr, cause });
        }
        return { dialect: "regex", pattern, flags: flags || undefined };
    }
    return { dialect: "glob", pattern: expr };
}
