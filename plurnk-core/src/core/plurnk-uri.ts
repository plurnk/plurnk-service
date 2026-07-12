// The plurnk:// addressing convention. A namespace lives in the URL authority slot
// (plurnk://docs/x.md, plurnk://prompt/<run>/<loop>/<N>), but the canonical STORAGE key is the full
// path with the namespace folded in (/docs/x.md) — entries are keyed by (scope, scheme,
// pathname) with no authority column, so the authority MUST fold into the path.
//
//   fold   = parse-side: authority → path. Generic; a no-op when there's no authority.
//   render = the inverse: path → model-facing URI. A multi-segment plurnk path promotes its
//            first segment to the authority slot; a single-segment singleton (manifest.json,
//            an alias doc) stays empty-authority root. Non-plurnk schemes are untouched.
//
// A web host (http://en.wikipedia.org/…) is NOT a namespace and never folds — callers that
// see other schemes gate the fold on scheme === "plurnk"; the entry layer only ever sees
// empty-authority schemes, so it folds unconditionally (a no-op there).

import type { ParsedPath } from "@plurnk/plurnk-grammar";

// Bare paths default to the file scheme per plurnk.md (grammar sysprompt):
// "Bare paths (no scheme) default to local relative project file paths."
// file:/// remains an optional explicit form for absolute paths.
export function schemeNameOf(path: ParsedPath | null): string | null {
    if (path === null) return null;
    // http + https are one scheme — the http sibling owns both prefixes (#195).
    if (path.kind === "url") return path.scheme === "https" ? "http" : path.scheme;
    return "file";  // local (bare) → file
}

export function foldAuthorityIntoPath(hostname: string | null, pathname: string): string {
    return hostname ? `/${hostname}${pathname}` : pathname;
}

// §prompt-auto-read — the prompt address is RUN-QUALIFIED (#382 fault-1): entries are
// session-scoped while loop sequences are per-run, so every run's first loop is sequence 1 and
// a WORK-spawned sister's turn-1 foist would clobber its parent's /prompt/1/1. The run id in
// the path is /proc/<pid>-style process qualification — one filesystem, collision-free
// coordinates. Every prompt writer and query builds through these two.
export function promptPathname(runId: number, loopSeq: number, turnSeq: number): string {
    return `/prompt/${runId}/${loopSeq}/${turnSeq}`;
}

export function promptLoopPrefix(runId: number, loopSeq: number): string {
    return `/prompt/${runId}/${loopSeq}/`;
}

export function renderAddress(scheme: string, pathname: string): string {
    if (scheme === "plurnk" && pathname.split("/").filter((s) => s.length > 0).length >= 2) {
        return `plurnk://${pathname.replace(/^\//, "")}`;
    }
    // #370 — the run IS the authority (§run-scheme): a stored row whose authority was folded into
    // the pathname (/name/...) must render run://name/..., never run:///name/... — one packet was
    // minting BOTH forms and the model treated them as different addresses. Same for web URLs
    // (run42 sweep: the entry-sink's materialized pages rendered https:///en.wikipedia.org/...).
    // known/unknown/plurnk-single-segment keep :/// — empty authority IS their canonical form.
    if (scheme === "run" || scheme === "http" || scheme === "https") return `${scheme}://${pathname.replace(/^\//, "")}`;
    return `${scheme}://${pathname}`;
}
