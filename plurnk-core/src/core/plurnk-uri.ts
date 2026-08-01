// The plurnk:// addressing convention. A namespace lives in the URL authority slot
// (plurnk://docs/x.md, plurnk://skills/x.md), but the canonical STORAGE key is the full
// path with the namespace folded in (/docs/x.md) — entries are keyed by (scope, scheme,
// pathname) with no authority column, so the authority MUST fold into the path.
//
//   fold   = parse-side: authority → path. Generic; a no-op when there's no authority.
//   render = the inverse: path → model-facing URI. A multi-segment plurnk path promotes its
//            first segment to the authority slot; a single-segment singleton (manifest.json,
//            an alias doc) stays empty-authority root. Non-plurnk schemes are untouched.
//
// Network hosts are not plurnk namespaces, but storage has no separate authority
// column. They therefore use the same mechanical fold while retaining their
// addressed protocol as the scheme identity.

import type { ParsedPath } from "@plurnk/plurnk-contracts/grammar";
import { decodePathParens, encodePathParens } from "./path-decode.ts";

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

export function entryPathnameOf(path: ParsedPath): string {
    const pathname = path.kind === "url"
        ? foldAuthorityIntoPath(path.hostname, path.pathname)
        : path.raw;
    return decodePathParens(pathname);
}

// {§prompt-self-only} — the prompt address is prompt:///<loopSeq>/<turnSeq>: the OWNER rides the
// owner_id column ({§entry-owner}), so the coordinate is bare and loop-relative — the last
// id-in-pathname (#382) is dead. Every prompt writer and query builds through these two; the
// owner scoping is the query's owner_id param, never a path segment.
export function promptPathname(loopSeq: number, turnSeq: number): string {
    return `/${loopSeq}/${turnSeq}`;
}

export function promptLoopPrefix(loopSeq: number): string {
    return `/${loopSeq}/`;
}

export function renderAddress(scheme: string, pathname: string): string {
    const encoded = encodePathParens(pathname);
    if (scheme === "plurnk" && pathname.split("/").filter((s) => s.length > 0).length >= 2) {
        return `plurnk://${encoded.replace(/^\//, "")}`;
    }
    // #370 — the worker IS the authority (§worker-scheme): a stored row whose authority was folded into
    // Web URLs carry a real host in the pathname's first segment — render it as the authority
    // (run42 sweep: the entry-sink's materialized pages rendered https:///en.wikipedia.org/...).
    // worker:// renders :/// — the owner rides owner_id ({§entry-owner}), so empty authority IS
    // the canonical stored form; a querying face re-applies its authority (~/name) for display.
    if (scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss") return `${scheme}://${encoded.replace(/^\//, "")}`;
    return `${scheme}://${encoded}`;
}
