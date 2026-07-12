import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol } from "@plurnk/plurnk-mimetypes";

// text/x-diff handler (Tier 4 hand-roll, no parser dependency).
//
// Why hand-rolled — tree-sitter-diff is empirically disqualified. A unified
// diff is rigidly line-oriented, and the one fact that disambiguates it is
// NON-context-free: the hunk header `@@ -a,b +c,d @@` declares a LINE BUDGET
// (b old slots + d new slots). Only by tracking remaining budget can a `-`
// line whose content begins with `--` (e.g. deleting `--- old config`) be
// known to be a deletion rather than the start of a new file header. A
// context-free grammar can't count that budget, so tree-sitter-diff
// mis-classifies; and on combined/merge diffs (`diff --cc`, `@@@`) it ERRORs
// outright. A focused line scanner has neither problem. (plurnk-mimetypes#0
// probe, 2026-06: a ~53-LOC prototype matched `git diff --shortstat`
// byte-exact on a 10,894-line real diff.)
//
// Symbol model: each file section → `module` (name = new path, or `old → new`
// for renames, or old path for pure deletions). Each hunk → `field` (a member
// of the file; hunks aren't callable), named by git's section-heading text
// when present (`function greet(name) {` — name-joinable to source entries),
// else by its new-file coordinates `@@ +c,d`. line/endLine span the section /
// hunk WITHIN THE DIFF DOCUMENT (not the target file).
//
// deepJson carries the target-file ranges + per-file stats for jsonpath: a
// `{ type:"diff", files:[{ type:"file", ..., hunks:[{ type:"hunk", ... }] }] }`
// tree that projects cleanly to deep-xml (each object's `type` names the
// element; oldStart/newStart/counts/heading become queryable child elements).
//
// References are deferred (refs-free for v1). A future file-path use-edge is
// plausible — entry paths are in-corpus, so a diff's touched paths could link
// to the entries they patch — but it is NOT built here (precision over
// speculation).
export default class TextDiff extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        const { files } = scanDiff(toText(content));
        const out: MimeSymbol[] = [];
        for (const f of files) {
            const name = sectionName(f);
            out.push({
                name,
                kind: "module",
                line: f.line,
                endLine: f.endLine,
            });
            for (const h of f.hunks) {
                out.push({
                    name: h.heading ?? `@@ +${h.newStart},${h.newCount}`,
                    kind: "field",
                    line: h.line,
                    endLine: h.endLine,
                    container: name,
                });
            }
        }
        return out;
    }

    override deepJson(content: HandlerContent): unknown {
        const { files } = scanDiff(toText(content));
        return {
            type: "diff",
            // Document span so a match on the root (e.g. $.type) resolves to a
            // source line via walk-up (#41), not absent.
            line: 1,
            endLine: files.reduce((m, f) => Math.max(m, f.endLine), 1),
            files: files.map((f) => ({
                type: "file",
                oldPath: f.oldPath,
                newPath: f.newPath,
                line: f.line,
                endLine: f.endLine,
                additions: f.additions,
                deletions: f.deletions,
                binary: f.binary,
                hunks: f.hunks.map((h) => ({
                    type: "hunk",
                    oldStart: h.oldStart,
                    oldCount: h.oldCount,
                    newStart: h.newStart,
                    newCount: h.newCount,
                    heading: h.heading,
                    line: h.line,
                    endLine: h.endLine,
                })),
            })),
        };
    }
}

function toText(content: HandlerContent): string {
    return typeof content === "string"
        ? content
        : new TextDecoder("utf-8").decode(content);
}

// File-section symbol name: `old → new` for renames, old path for pure
// deletions (new is /dev/null), else the new path.
function sectionName(f: DiffFile): string {
    if (f.rename && f.oldPath && f.newPath) return `${f.oldPath} → ${f.newPath}`;
    if (f.newPath === null && f.oldPath !== null) return f.oldPath;
    return f.newPath ?? f.oldPath ?? "";
}

export interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    heading: string | null;
    line: number;     // 1-indexed start within the diff document
    endLine: number;  // 1-indexed end within the diff document
}

export interface DiffFile {
    oldPath: string | null;
    newPath: string | null;
    rename: boolean;
    binary: boolean;
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
    line: number;
    endLine: number;
}

export interface DiffScan {
    files: DiffFile[];
}

// Strip a/ b/ c/ i/ w/ prefix from a diff path token; map /dev/null to null;
// drop the timestamp tail git/diff append to ---/+++ lines (tab- or
// space-separated). Quoted paths (git quotes paths with special chars) are
// unquoted.
function cleanPath(raw: string): string | null {
    let p = raw;
    // Strip a trailing timestamp/metadata after a tab (the canonical
    // separator) — `--- a/file.c\t2026-01-01 12:00:00.000 +0000`.
    const tab = p.indexOf("\t");
    if (tab >= 0) p = p.slice(0, tab);
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
    if (p === "/dev/null") return null;
    const m = /^[abciw]\/(.*)$/.exec(p);
    if (m) return m[1];
    return p;
}

// Parse a unified hunk header `@@ -a,b +c,d @@ heading` or a combined header
// `@@@ -a,b -e,f +c,d @@@ heading` (N parents → N old ranges, one new range).
// Returns null on no match. The line budget is the SUM of every range's count
// (each old range and the new range consumes one slot per content line in the
// hunk body).
function parseHunkHeader(line: string): {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    budget: number;
    heading: string | null;
    fenceWidth: number;
} | null {
    const m = /^(@{2,})\s+(.*?)\s+\1(.*)$/.exec(line);
    if (!m) return null;
    const fence = m[1];
    const ranges = m[2].trim().split(/\s+/);
    const heading = m[3].length > 0 ? m[3].replace(/^\s+/, "") : null;
    const fenceWidth = fence.length - 1; // N parents for combined; 1 for plain

    let firstOld: { start: number; count: number } | null = null;
    let last: { start: number; count: number } | null = null;
    let budget = 0;
    for (const r of ranges) {
        const rm = /^[-+](\d+)(?:,(\d+))?$/.exec(r);
        if (!rm) return null;
        const start = Number(rm[1]);
        const count = rm[2] === undefined ? 1 : Number(rm[2]);
        budget += count;
        if (r.startsWith("-") && firstOld === null) firstOld = { start, count };
        last = { start, count };
    }
    if (firstOld === null || last === null) return null;
    return {
        oldStart: firstOld.start,
        oldCount: firstOld.count,
        newStart: last.start,
        newCount: last.count,
        budget,
        heading,
        fenceWidth,
    };
}

// Single line-oriented pass. The one piece of state is the hunk line budget
// (remaining old+new slots). While a hunk is open with budget remaining, lines
// whose leading `fenceWidth` columns are `+`/`-`/space are authoritative hunk
// content — consumed verbatim. That authority is what resolves the
// `--`-content ambiguity a grammar can't.
export function scanDiff(text: string): DiffScan {
    const lines = text.split("\n");
    // A trailing newline yields a final empty element; drop it so it doesn't
    // inflate spans (it is the line terminator, not a line).
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const files: DiffFile[] = [];
    let file: DiffFile | null = null;
    let hunk: DiffHunk | null = null;
    let budget = 0;
    let fenceWidth = 1;
    let pendingOld: string | null = null; // a `---` seen, awaiting its `+++`

    const closeHunk = (endLine: number): void => {
        if (hunk) { hunk.endLine = endLine; hunk = null; }
        budget = 0;
    };
    const closeFile = (endLine: number): void => {
        closeHunk(endLine);
        if (file) { file.endLine = endLine; file = null; }
        pendingOld = null;
    };
    const openFile = (lineNo: number): DiffFile => {
        closeFile(lineNo - 1);
        const f: DiffFile = {
            oldPath: null, newPath: null, rename: false, binary: false,
            additions: 0, deletions: 0, hunks: [], line: lineNo, endLine: lineNo,
        };
        files.push(f);
        return f;
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineNo = i + 1;

        // Inside an open hunk with budget remaining, prefix columns are
        // authoritative. This MUST be tested before any header match so a
        // deletion of `--- old config` is consumed as content, not read as a
        // file header (the trap that justifies the hand-roll).
        if (hunk && budget > 0) {
            const prefix = line.slice(0, fenceWidth);
            // `\ No newline at end of file` is a non-content annotation; it
            // belongs to the preceding +/- line and consumes no budget.
            if (line.startsWith("\\")) continue;
            if (isHunkContent(prefix, fenceWidth)) {
                budget -= countSlots(prefix, fenceWidth);
                if (file) {
                    if (prefix.includes("+")) file.additions += 1;
                    if (prefix.includes("-")) file.deletions += 1;
                }
                file!.endLine = lineNo;
                hunk.endLine = lineNo;
                if (budget <= 0) closeHunk(lineNo);
                continue;
            }
            // Mid-hunk garbage (no valid prefix): close the hunk and re-scan
            // this line as a potential header below.
            closeHunk(lineNo - 1);
        }

        // `diff --git a/X b/Y` (or `diff --cc`/`--combined`) opens a section
        // and recovers both paths (survives binary / mode-only sections that
        // carry no ---/+++ pair).
        const git = /^diff --(?:git|cc|combined)\s+(.*)$/.exec(line);
        if (git) {
            const f = openFile(lineNo);
            file = f;
            const paths = parseGitPaths(git[1]);
            if (paths) { f.oldPath = paths.old; f.newPath = paths.new; }
            continue;
        }

        // Extended headers within a section.
        if (file && !hunk) {
            const ren = /^rename (from|to) (.+)$/.exec(line);
            if (ren) {
                file.rename = true;
                if (ren[1] === "from") file.oldPath = cleanPath(ren[2]);
                else file.newPath = cleanPath(ren[2]);
                file.endLine = lineNo;
                continue;
            }
            if (/^Binary files /.test(line) || /^GIT binary patch/.test(line)) {
                file.binary = true;
                file.endLine = lineNo;
                continue;
            }
        }

        // `--- old` line. Inside a git section it refines the old path; with no
        // open section (bare `diff -u` output) it OPENS one.
        const minus = /^--- (.*)$/.exec(line);
        if (minus) {
            if (!file) { file = openFile(lineNo); }
            file.oldPath = cleanPath(minus[1]);
            file.endLine = lineNo;
            pendingOld = minus[1];
            continue;
        }
        // `+++ new` line completes the ---/+++ pair.
        const plus = /^\+\+\+ (.*)$/.exec(line);
        if (plus && pendingOld !== null) {
            file!.newPath = cleanPath(plus[1]);
            file!.endLine = lineNo;
            pendingOld = null;
            continue;
        }

        // Hunk header. Opens a hunk and seeds the line budget.
        const hh = parseHunkHeader(line);
        if (hh && file) {
            closeHunk(lineNo - 1);
            const h: DiffHunk = {
                oldStart: hh.oldStart, oldCount: hh.oldCount,
                newStart: hh.newStart, newCount: hh.newCount,
                heading: hh.heading, line: lineNo, endLine: lineNo,
            };
            file.hunks.push(h);
            hunk = h;
            budget = hh.budget;
            fenceWidth = hh.fenceWidth;
            file.endLine = lineNo;
            continue;
        }

        // Other git extended headers (index, mode, similarity, new/deleted
        // file mode, etc.) extend the section span without their own meaning.
        if (file && !hunk && isExtendedHeader(line)) {
            file.endLine = lineNo;
            continue;
        }

        // Interleaved garbage with no open section: skip.
    }

    closeFile(lines.length);
    return { files };
}

// A combined diff's prefix is `fenceWidth` columns, each `+`/`-`/space. A
// plain diff is one column. An all-space prefix is a context line; any `+`/`-`
// makes it an add/del column.
function isHunkContent(prefix: string, fenceWidth: number): boolean {
    if (prefix.length < fenceWidth) return false;
    for (let i = 0; i < fenceWidth; i += 1) {
        const c = prefix[i];
        if (c !== "+" && c !== "-" && c !== " ") return false;
    }
    return true;
}

// Budget accounting: a context line (all spaces) consumes one old + one new
// slot per column-pair, but for budget purposes we count it as touching every
// range, i.e. fenceWidth + 1 slots (each parent's old range + the new range).
// A pure addition (`+`) touches only the new range (1 slot). A pure deletion
// touches the old range(s). To stay budget-exact against the header sum we
// count: every non-`+` column contributes one old slot; the new column
// contributes one slot unless the line is a pure deletion in ALL columns.
function countSlots(prefix: string, fenceWidth: number): number {
    let slots = 0;
    let anyAdd = false;
    let anyNonAdd = false;
    for (let i = 0; i < fenceWidth; i += 1) {
        const c = prefix[i];
        if (c === "+") { anyAdd = true; continue; }
        // space or `-` consumes that parent's old slot.
        slots += 1;
        anyNonAdd = true;
    }
    // The new range gains a line unless this is a pure deletion (every column
    // is `-`, no space, no `+`) — a deletion removes from old, adds nothing new.
    const pureDeletion = !anyAdd && !prefixHasSpace(prefix, fenceWidth);
    if (!pureDeletion) slots += 1;
    // `anyNonAdd` guards the all-`+` combined case from under-counting the new
    // slot (handled above: pure add → slots stays at the +1 for the new range).
    void anyNonAdd;
    return slots;
}

function prefixHasSpace(prefix: string, fenceWidth: number): boolean {
    for (let i = 0; i < fenceWidth; i += 1) if (prefix[i] === " ") return true;
    return false;
}

// Git extended-header lines that live inside a `diff --git` section before the
// hunks. Recognized so they extend the section span and never get mistaken for
// content or garbage.
function isExtendedHeader(line: string): boolean {
    return /^(old mode|new mode|deleted file mode|new file mode|copy from|copy to|index |similarity index|dissimilarity index|mode )/.test(line);
}

// Recover old/new paths from a `diff --git a/X b/Y` line. Paths may contain
// spaces, which makes the split ambiguous; git's convention is `a/` then `b/`,
// so split on the ` b/` boundary when both carry the conventional prefixes,
// else fall back to the last-space split.
function parseGitPaths(rest: string): { old: string | null; new: string | null } | null {
    const r = rest.trim();
    // Quoted form: `"a/x y" "b/z"`.
    const quoted = /^"(.+)"\s+"(.+)"$/.exec(r);
    if (quoted) return { old: cleanPath(`"${quoted[1]}"`), new: cleanPath(`"${quoted[2]}"`) };
    // Common form with a/ b/ prefixes; split on the ` b/` boundary.
    const bIdx = r.indexOf(" b/");
    if (r.startsWith("a/") && bIdx > 0) {
        return { old: cleanPath(r.slice(0, bIdx)), new: cleanPath(r.slice(bIdx + 1)) };
    }
    // Fallback: midpoint split (identical paths are the common case here).
    const parts = r.split(" ");
    if (parts.length === 2) return { old: cleanPath(parts[0]), new: cleanPath(parts[1]) };
    const mid = parts.length / 2;
    return {
        old: cleanPath(parts.slice(0, mid).join(" ")),
        new: cleanPath(parts.slice(mid).join(" ")),
    };
}
