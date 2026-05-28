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
// inherently mimetype-bound (xpath: XML/HTML parse; jsonpath: JSON
// walk) and belong in @plurnk/plurnk-mimetypes per-mimetype handlers
// (filed: plurnk-mimetypes#3). Until that lands, xpath/jsonpath return
// 501 with a pointer to the issue.
//
// Mimetype-mismatch rule (AGENTS.md "Resolved ambiguities" §1):
// dialect on a wrong mimetype family returns 415. xpath on text/plain
// → 415; jsonpath on text/html → 415. Binary entries are 415 across
// the board (§2).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import { isBinaryMimetype } from "./mimetype-binary.ts";

const isXmlFamily = (mimetype: string): boolean =>
    mimetype === "text/html" || mimetype === "application/xml" || mimetype.endsWith("+xml");

const isJsonFamily = (mimetype: string): boolean =>
    mimetype === "application/json" || mimetype.endsWith("+json");

export interface MatchResult {
    status: number;
    matches?: string[];
    error?: string;
}

// Apply a matcher against text content. READ semantics: returns matched
// substrings.
export const matchAgainstContent = (body: MatcherBody, content: string, mimetype: string): MatchResult => {
    if (isBinaryMimetype(mimetype)) {
        return { status: 415, error: `cannot match against binary mimetype \`${mimetype}\`` };
    }
    if (body.dialect === "regex") {
        let re: RegExp;
        try { re = new RegExp(body.pattern, body.flags); }
        catch (err) { return { status: 400, error: err instanceof Error ? err.message : String(err) }; }
        if (body.flags.includes("g")) {
            return { status: 200, matches: content.match(re) ?? [] };
        }
        const m = content.match(re);
        return { status: 200, matches: m === null ? [] : [m[0]] };
    }
    if (body.dialect === "xpath") {
        if (!isXmlFamily(mimetype)) return { status: 415, error: `xpath requires xml/html mimetype; got \`${mimetype}\`` };
        return { status: 501, error: "xpath not implemented (see plurnk-mimetypes#3)" };
    }
    if (body.dialect === "jsonpath") {
        if (!isJsonFamily(mimetype)) return { status: 415, error: `jsonpath requires json mimetype; got \`${mimetype}\`` };
        return { status: 501, error: "jsonpath not implemented (see plurnk-mimetypes#3)" };
    }
    // glob over arbitrary content has no clear semantics; pathname glob is
    // the actual use case (handled in _entry-find.ts for FIND scope).
    return { status: 501, error: "glob over content not supported; glob applies to FIND target paths" };
};
