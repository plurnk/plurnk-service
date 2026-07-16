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
    // Prefix aliasing: http + https are one scheme (#195), ws + wss are one scheme (#473 — Ws is
    // the http package's second first-class scheme, registered `wss` via plurnk.schemes). The
    // secure prefix names the handler; the plain prefix rides it.
    if (path.kind === "url") {
        if (path.scheme === "https") return "http";
        if (path.scheme === "ws") return "wss";
        return path.scheme;
    }
    return "file";  // local (bare) → file
}

export function foldAuthorityIntoPath(hostname: string | null, pathname: string): string {
    return hostname ? `/${hostname}${pathname}` : pathname;
}

// §prompt-auto-read — the prompt address is RUN-QUALIFIED (#382 fault-1): entries are
// workspace-scoped while loop sequences are per-run, so every run's first loop is sequence 1 and
// a WORK-spawned sister's turn-1 foist would clobber its parent's /prompt/1/1. The run id in
// the path is /proc/<pid>-style process qualification — one filesystem, collision-free
// coordinates. Every prompt writer and query builds through these two.
export function promptPathname(workerId: number, loopSeq: number, turnSeq: number): string {
    return `/prompt/${workerId}/${loopSeq}/${turnSeq}`;
}

export function promptLoopPrefix(workerId: number, loopSeq: number): string {
    return `/prompt/${workerId}/${loopSeq}/`;
}

export function renderAddress(scheme: string, pathname: string): string {
    if (scheme === "plurnk" && pathname.split("/").filter((s) => s.length > 0).length >= 2) {
        return `plurnk://${pathname.replace(/^\//, "")}`;
    }
    // #370 — the run IS the authority (§run-scheme): a stored row whose authority was folded into
    // the pathname (/name/...) must render worker://name/..., never worker:///name/... — one packet was
    // minting BOTH forms and the model treated them as different addresses. Same for web URLs
    // (run42 sweep: the entry-sink's materialized pages rendered https:///en.wikipedia.org/...).
    // known/unknown/plurnk-single-segment keep :/// — empty authority IS their canonical form.
    if (scheme === "worker" || scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss") return `${scheme}://${pathname.replace(/^\//, "")}`;
    return `${scheme}://${pathname}`;
}
