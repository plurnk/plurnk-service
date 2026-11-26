import picomatch from "picomatch";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import { InvalidExpressionError } from "./QueryError.ts";
import type { QueryMatch } from "./types.ts";
import TextCoordinates from "./TextCoordinates.ts";

type LocateMatch = (start: number, end: number) => Pick<QueryMatch, "regions" | "enclosingRegions">;

function textLocations(text: string): LocateMatch {
    const coordinates = new TextCoordinates(text);
    return (start, end) => {
        const region = coordinates.regionFromOffsets(start, end);
        if (region !== null) return { regions: [region] };
        const enclosing = coordinates.enclosingRegionFromOffsets(start, end);
        return enclosing === null ? {} : { enclosingRegions: [enclosing] };
    };
}

function escapeLiteralPattern(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\r\n|\r|\n/gu, "\\r?\\n");
}

function execRegexMatches(text: string, regex: RegExp, unicode: boolean, locate: LocateMatch): QueryMatch[] {
    const out: QueryMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        out.push({
            matched: shapeMatched(m),
            text: m[0],
            ...locate(m.index, m.index + m[0].length),
        });
        // Defend against zero-length matches infinite-looping the global regex.
        if (m[0].length === 0) {
            regex.lastIndex = advanceStringIndex(text, regex.lastIndex, unicode);
        }
    }
    return out;
}

// regex against arbitrary text. Returns one QueryMatch per match. Polymorphic
// `matched` shape under {§mimetype-query}:
//   - no captures → string (the whole match)
//   - anonymous captures → readonly string[] (positional only)
//   - named captures (and mixed) → object with named keys and positional
//     "1", "2", ... keys
//
// Always runs with the global flag so we get every match. Trailing /flags
// from the matcher syntax are honored.
export function queryRegex(text: string, pattern: string, flags?: string, locate: LocateMatch = textLocations(text)): QueryMatch[] {
    const effective = flags ?? "";
    const withGlobal = effective.includes("g") ? effective : effective + "g";
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, withGlobal);
    } catch (cause) {
        throw new InvalidExpressionError({ dialect: "regex", expression: pattern, cause });
    }

    const unicode = withGlobal.includes("u") || withGlobal.includes("v");
    const out = execRegexMatches(text, regex, unicode, locate);
    if (out.length > 0 || text.length === 0) return out;

    // {§parse-recovery} — when a regex with unescaped code delimiters (`(`, `)`, `[`, `]`, `$`)
    // produces 0 matches, check whether the pattern (or the pattern with literal parens) matches source text.
    if (/[()[\]{}$^]/u.test(pattern)) {
        const literalCandidate = pattern.replace(/\\\//gu, "/");
        if (literalCandidate.length > 1) {
            const literalFlags = effective.includes("i") ? "giu" : "gu";
            const literalRegex = new RegExp(escapeLiteralPattern(literalCandidate), literalFlags);
            const literalMatches = execRegexMatches(text, literalRegex, true, locate);
            if (literalMatches.length > 0) return literalMatches;
        }
        if (/(?<!\\)[()]/u.test(pattern)) {
            const escapedParens = pattern.replace(/(?<!\\)([()])/gu, "\\$1");
            try {
                const parenRegex = new RegExp(escapedParens, withGlobal);
                const parenMatches = execRegexMatches(text, parenRegex, unicode, locate);
                if (parenMatches.length > 0) return parenMatches;
            } catch {
                // Ignore if escaping parens invalidates a construct
            }
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

// {§mimetype-query} — literals select occurrences; glob syntax selects whole lines.
export function queryGlob(text: string, pattern: string, locate: LocateMatch = textLocations(text)): QueryMatch[] {
    if (!/[\r\n]/u.test(pattern) && pattern.includes("\\n") && !text.includes(pattern)) {
        const unescaped = pattern.replaceAll("\\r\\n", "\r\n").replaceAll("\\n", "\n");
        if (/[\r\n]/u.test(unescaped) && text.includes(unescaped)) {
            return queryRegex(text, escapeLiteralPattern(unescaped), "u", locate);
        }
    }
    if (/[\r\n]/u.test(pattern) || !PathSyntax.hasGlob(pattern)) {
        return queryRegex(text, escapeLiteralPattern(pattern), "u", locate);
    }
    if (pattern.length > 1 && text.includes(pattern)) {
        return queryRegex(text, escapeLiteralPattern(pattern), "u", locate);
    }
    let regex: RegExp;
    try {
        regex = globToRegex(pattern);
    } catch (err) {
        if (text.includes(pattern)) {
            return queryRegex(text, escapeLiteralPattern(pattern), "u", locate);
        }
        throw err;
    }
    const coordinates = new TextCoordinates(text);
    const lines = coordinates.logicalLines();
    const out: QueryMatch[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const body = text.slice(line.start, line.contentEnd);
        if (regex.test(body)) {
            out.push({
                matched: body,
                // {§mimetype-query} — the matching line rides as `text`, like a regex match,
                // so a FIND row can show it without a READ.
                text: body,
                ...locate(line.start, line.contentEnd),
            });
        }
    }
    return out;
}

// Pick a return shape for a regex match under the polymorphism rule in
// {§mimetype-query}.
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

// {§parse-recovery} — escape unbalanced literal function-call parentheses, empty code brackets (`[]`),
// or subscript brackets in code-snippet globs (`*ForeignKey('self'*`, `*items[0*`, `*notes=[]*`) while
// keeping malformed extglobs (`@(a|b`) and standalone character classes (`[abc`) as invalid glob expressions.
function repairUnbalancedCodeGlob(glob: string): string | null {
    const toEscape = new Set<number>();
    const openBrackets: Array<{ index: number; isSubscript: boolean }> = [];
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (ch === "[" && openBrackets.length === 0) {
            if (glob[i + 1] === "]") {
                toEscape.add(i);
                toEscape.add(i + 1);
                i += 1;
                continue;
            }
            const prev = i > 0 ? glob[i - 1] : "";
            openBrackets.push({ index: i, isSubscript: /[A-Za-z0-9_.)\]]/u.test(prev) });
        } else if (ch === "]" && openBrackets.length > 0) {
            openBrackets.pop();
        }
    }
    for (const open of openBrackets) {
        if (!open.isSubscript) return null;
        toEscape.add(open.index);
    }

    let inBracket = false;
    const openParens: Array<{ index: number; isExtglob: boolean }> = [];
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (ch === "[" && !toEscape.has(i) && !inBracket) {
            inBracket = true;
            continue;
        }
        if (ch === "]" && inBracket) {
            inBracket = false;
            continue;
        }
        if (inBracket) continue;
        if (ch === "(") {
            const prev = i > 0 ? glob[i - 1] : "";
            const prevEscaped = i > 1 && glob[i - 2] === "\\";
            const isExtglob = !prevEscaped && /[*+?@!]/u.test(prev);
            openParens.push({ index: i, isExtglob });
        } else if (ch === ")") {
            if (openParens.length > 0) {
                openParens.pop();
            } else {
                toEscape.add(i);
            }
        }
    }
    for (const open of openParens) {
        if (open.isExtglob) return null;
        toEscape.add(open.index);
    }
    if (toEscape.size === 0) return null;
    let out = "";
    for (let i = 0; i < glob.length; i += 1) {
        if (toEscape.has(i)) out += "\\";
        out += glob[i];
    }
    return out;
}

const PICOMATCH_GLOB_OPTIONS = {
    bash: true,
    dot: true,
    nonegate: true,
    posix: true,
    strictBrackets: true,
} as const;

// Translate the {§mimetype-query} glob dialect to an anchored regex. Exported
// so consumers can reuse its exact semantics without inventing another glob
// language when they need a predicate rather than query evidence.
export function globToRegex(glob: string): RegExp {
    try {
        return picomatch.makeRe(glob, PICOMATCH_GLOB_OPTIONS);
    } catch (cause) {
        const repaired = repairUnbalancedCodeGlob(glob);
        if (repaired !== null) {
            try {
                return picomatch.makeRe(repaired, PICOMATCH_GLOB_OPTIONS);
            } catch {
                // Fall through to InvalidExpressionError with original cause
            }
        }
        throw new InvalidExpressionError({ dialect: "glob", expression: glob, cause });
    }
}
