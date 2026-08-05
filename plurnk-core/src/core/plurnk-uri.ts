// {§scheme-address} — registered non-network scheme authorities mechanically fold
// into the stored pathname. Rendering uses the canonical empty-authority form.
// Network schemes instead restore the stored host to the authority slot.

import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import { NetworkAddress } from "@plurnk/plurnk-schemes";

export interface RenderTargetParts {
    readonly scheme: string | null | undefined;
    readonly hostname?: string | null;
    readonly port?: number | null;
    readonly pathname: string | null | undefined;
    readonly query?: string | null;
    readonly fragment?: string | null;
}

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
    if (path.kind === "url" && NetworkAddress.supports(path.scheme)) {
        return NetworkAddress.from(path).pathname;
    }
    const pathname = path.kind === "url"
        ? foldAuthorityIntoPath(path.hostname, path.pathname)
        : path.raw;
    return PathSyntax.decodeParens(pathname);
}

// {§prompt-self-only} — the prompt address is prompt:///<loopSeq>/<turnSeq>: the OWNER rides the
// owner_id column ({§entry-owner}), so the coordinate is bare and loop-relative — the last
// owner scoping is the query's owner_id param, never a path segment. Every
// prompt writer and query builds through these two helpers.
export function promptPathname(loopSeq: number, turnSeq: number): string {
    return `/${loopSeq}/${turnSeq}`;
}

export function promptLoopPrefix(loopSeq: number): string {
    return `/${loopSeq}/`;
}

export function renderAddress(scheme: string, pathname: string): string {
    if (NetworkAddress.supports(scheme)) return NetworkAddress.render(scheme, pathname);
    const encoded = PathSyntax.encodeParens(pathname);
    // {§scheme-address} — network storage folds the host into the pathname and
    // model-facing rendering restores it to the authority slot.
    // worker:// renders :/// — the owner rides owner_id ({§entry-owner}), so empty authority IS
    // the canonical stored form; a querying face re-applies its authority (~/name) for display.
    return PathSyntax.escapeTarget(`${scheme}://${encoded}`);
}

/** Render one stored target without exposing credentials or request metadata. {§scheme-address} */
export function renderTarget(target: RenderTargetParts): string | null {
    if (target.pathname === null || target.pathname === undefined) return null;

    const hostname = target.hostname ?? null;
    const scheme = target.scheme ?? null;
    let address: string;
    if (scheme === null) {
        address = PathSyntax.escapeTarget(PathSyntax.encodeParens(target.pathname.replace(/^\//, "")));
    } else if (hostname !== null && hostname.length > 0) {
        const port = target.port === null || target.port === undefined ? "" : `:${target.port}`;
        address = PathSyntax.escapeTarget(`${scheme}://${hostname}${port}${PathSyntax.encodeParens(target.pathname)}`);
    } else {
        address = renderAddress(scheme, target.pathname);
    }

    if (target.query !== null && target.query !== undefined) {
        address += `?${PathSyntax.escapeTarget(target.query)}`;
    }
    if (target.fragment !== null && target.fragment !== undefined && target.fragment.length > 0) {
        address += `#${PathSyntax.escapeTarget(target.fragment)}`;
    }
    return address.length === 0 ? null : address;
}
