// Body-matcher dispatch for FIND / READ / SHOW / HIDE (plurnk.md
// §"Body matcher dispatch"). The grammar parser classifies the dialect
// at parse time and emits a discriminated MatcherBody:
//
//   { dialect: "xpath",    raw, ... }
//   { dialect: "regex",    raw, pattern, flags }
//   { dialect: "jsonpath", raw, ... }
//   { dialect: "glob",     raw }
//
// Regex + glob are universal text matching. xpath + jsonpath are
// inherently mimetype-bound and belong on per-mimetype handlers in
// @plurnk/plurnk-mimetypes (plurnk-mimetypes#3). 501 with sibling-issue
// pointer until landed.
//
// Mimetype-mismatch rule (AGENTS.md "Resolved ambiguities" §1): dialect
// on a wrong mimetype family returns 415. Binary entries are 415 across
// the board (§2).
//
// Result shape (AGENTS.md "Matcher return semantics rework"):
//   Body is a JSON array of per-match objects `{line, matched, matching?}`.
//   `line`: 1-indexed source line of the match.
//   `matched`: extracted value, polymorphic by extractor:
//     bare regex → string (full match)
//     anon captures → array of capture strings
//     named captures → object {name: value, …}; mixed anon mixes in "1"/"2"
//     jsonpath → JSON value at the path
//     xpath text/attr → string
//     xpath node → serialized XML string
//   `matching`: per-instance discriminator when matcher targets multiple
//     instances (jsonpath wildcards, xpath multi-match). Omitted otherwise.
//   Empty matches → status 204, no body.
//   Result mimetype is always "application/json" for matcher results.

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import { isBinaryMimetype } from "./mimetype-binary.ts";

const isXmlFamily = (mimetype: string): boolean =>
    mimetype === "text/html" || mimetype === "application/xml" || mimetype.endsWith("+xml");

const isJsonFamily = (mimetype: string): boolean =>
    mimetype === "application/json" || mimetype.endsWith("+json");

export interface MatchRow {
    line: number;
    matched: unknown;
    matching?: string | number;
}

export interface MatchResult {
    status: number;
    body?: string;        // JSON-array pretty-print (status 200 only)
    matches?: number;     // count of matches (status 200 or 204)
    error?: string;       // status >= 400 paths
}

// Count newlines in content[0..offset) to compute 1-indexed source line.
const lineOfOffset = (content: string, offset: number, baseLine: number): number => {
    let line = baseLine;
    for (let i = 0; i < offset && i < content.length; i++) {
        if (content.charCodeAt(i) === 0x0a) line++;
    }
    return line;
};

// Extract `matched` shape from a RegExp match result.
// - No captures: string (full match)
// - Anon only: array of capture strings
// - Named (any): object with name keys; anon captures merged in as "1", "2", …
const matchedFromRegex = (m: RegExpMatchArray | RegExpExecArray): unknown => {
    const anonCount = m.length - 1;  // m[0] is full match
    const groups = (m as RegExpMatchArray & { groups?: Record<string, string | undefined> }).groups;
    const hasNamed = groups !== undefined && Object.keys(groups).length > 0;

    if (anonCount === 0 && !hasNamed) return m[0];  // bare match

    if (hasNamed) {
        // Object form: named captures by name, anon captures by positional key.
        const obj: Record<string, string | undefined> = { ...groups };
        // Identify which capture indices are named (so we don't double-count).
        // RegExp doesn't expose this directly; collect named values and check
        // each anon position for presence in groups.
        const namedValues = new Set(Object.values(groups));
        for (let i = 1; i <= anonCount; i++) {
            const v = m[i];
            // Heuristic: include anon-indexed capture if it's not the same
            // reference as a named one. Imperfect when values collide; the
            // common case (truly distinct anon + named) works.
            if (!namedValues.has(v)) obj[String(i)] = v;
        }
        return obj;
    }

    // Anonymous-only: array of captures.
    const arr: (string | undefined)[] = [];
    for (let i = 1; i <= anonCount; i++) arr.push(m[i]);
    return arr;
};

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

// Convert a shell-style glob pattern to a RegExp for full-line matching.
// Per plurnk-grammar#17 closing comment, glob in READ body is a line
// filter: each content line tested against the glob; matching lines
// yield rows. Conventions match shell globs:
//   `TODO*`   → starts with TODO   (`^TODO.*$`)
//   `*TODO*`  → contains TODO      (`^.*TODO.*$`)
//   `*.log`   → ends with `.log`   (`^.*\.log$`)
//   `[Tt]odo*`→ char class anchor  (`^[Tt]odo.*$`)
// Model controls anchoring via the pattern; no implicit "contains" wrapping.
const globToLineRegex = (glob: string): RegExp => {
    let pattern = "^";
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === "*") {
            pattern += ".*";
        } else if (c === "?") {
            pattern += ".";
        } else if (c === "[") {
            // Character class — pass through with `!` → `^` per glob convention.
            let cls = "[";
            i++;
            if (i < glob.length && (glob[i] === "!" || glob[i] === "^")) {
                cls += "^";
                i++;
            }
            while (i < glob.length && glob[i] !== "]") {
                cls += glob[i];
                i++;
            }
            cls += "]";
            pattern += cls;
        } else if (".+(){}|^$\\".includes(c)) {
            pattern += `\\${c}`;
        } else {
            pattern += c;
        }
        i++;
    }
    pattern += "$";
    return new RegExp(pattern);
};

// Apply a matcher against text content. Returns a JSON-array body of
// per-match objects on success, or status 204 with no body when there
// are zero matches.
//
// `baseLine` is the 1-indexed line of `content[0]` in the original
// source. When the matcher runs against the full content, baseLine=1;
// when called from inside a `<L>` slice path, baseLine = slice startLine
// so per-match line numbers are reported in original-source coordinates.
export const matchAgainstContent = (
    body: MatcherBody,
    content: string,
    mimetype: string,
    baseLine: number = 1,
): MatchResult => {
    if (isBinaryMimetype(mimetype)) {
        return { status: 415, error: `cannot match against binary mimetype \`${mimetype}\`` };
    }
    if (body.dialect === "regex") {
        let re: RegExp;
        try { re = new RegExp(body.pattern, body.flags); }
        catch (err) { return { status: 400, error: err instanceof Error ? err.message : String(err) }; }

        const rows: MatchRow[] = [];
        if (body.flags.includes("g")) {
            for (const m of content.matchAll(re)) {
                const line = lineOfOffset(content, m.index ?? 0, baseLine);
                rows.push({ line, matched: matchedFromRegex(m) });
            }
        } else {
            const m = re.exec(content);
            if (m !== null) {
                const line = lineOfOffset(content, m.index, baseLine);
                rows.push({ line, matched: matchedFromRegex(m) });
            }
        }
        if (rows.length === 0) return { status: 204, matches: 0 };
        return { status: 200, body: prettyJson(rows), matches: rows.length };
    }
    if (body.dialect === "xpath") {
        if (!isXmlFamily(mimetype)) return { status: 415, error: `xpath requires xml/html mimetype; got \`${mimetype}\`` };
        return { status: 501, error: "xpath not implemented (see plurnk-mimetypes#3)" };
    }
    if (body.dialect === "jsonpath") {
        if (!isJsonFamily(mimetype)) return { status: 415, error: `jsonpath requires json mimetype; got \`${mimetype}\`` };
        return { status: 501, error: "jsonpath not implemented (see plurnk-mimetypes#3)" };
    }
    // glob in READ body = line filter (plurnk-grammar#17 ratification).
    // Each content line tested against the glob pattern; matching lines
    // yield `{line, matched: <lineContent>}` rows. Complements regex
    // (substring/capture extraction); glob is the grep-like primitive.
    let re: RegExp;
    try { re = globToLineRegex(body.raw); }
    catch (err) { return { status: 400, error: err instanceof Error ? err.message : String(err) }; }
    const lines = content.split("\n");
    const rows: MatchRow[] = [];
    lines.forEach((line, i) => {
        if (re.test(line)) {
            rows.push({ line: baseLine + i, matched: line });
        }
    });
    if (rows.length === 0) return { status: 204, matches: 0 };
    return { status: 200, body: prettyJson(rows), matches: rows.length };
};
