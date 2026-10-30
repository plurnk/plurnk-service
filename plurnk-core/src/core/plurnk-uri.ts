// {§scheme-address} — registered non-network scheme authorities mechanically fold
// into the stored pathname. Rendering uses the canonical empty-authority form.
// Network schemes instead restore the stored host to the authority slot.

import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import { EntryCoordinates, NetworkAddress, type EntryCoordinate } from "@plurnk/plurnk-schemes";
import FileAddress from "./FileAddress.ts";

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
    // {§scheme-address}: handler aliases route https through http and ws through wss
    // without collapsing the addressed scheme's resource identity.
    if (path.kind === "url") {
        return routedSchemeName(path.scheme);
    }
    return "file";  // local (bare) → file
}

function routedSchemeName(addressedScheme: string): string {
    if (addressedScheme === "http") return "https";
    if (addressedScheme === "ws") return "wss";
    return addressedScheme;
}

export const foldAuthorityIntoPath = EntryCoordinates.foldAuthority;
export const entryCoordinateOf = EntryCoordinates.resolve;

export function authorityParts(authority: string): { hostname: string | null; port: number | null } {
    if (authority.length === 0) return { hostname: null, port: null };
    const parsed = new URL(`plurnk-authority://${authority}/`);
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hostname.length === 0) {
        throw new TypeError(`Invalid resource authority ${JSON.stringify(authority)}.`);
    }
    return {
        hostname: parsed.hostname,
        port: parsed.port.length === 0 ? null : Number(parsed.port),
    };
}

export function renderAddress(address: EntryCoordinate & { readonly scheme: string }): string {
    if (NetworkAddress.supports(address.scheme)) return NetworkAddress.render(address);
    const { scheme, authority, pathname } = address;
    const encoded = PathSyntax.encodeParens(pathname);
    return PathSyntax.escapeTarget(`${scheme}://${authority}${encoded}`);
}

// {§fs-namespace} — what an address lacks is an entry, and in `file` an entry is a
// member. "No entry exists" reads there as a claim about the disk, which the engine never makes:
// this sentence is about the address's membership and is true whether or not a file is there.
export function missDetail(scheme: string | null, target: string): string {
    return scheme === "file" ? `No member of this workspace is at '${target}'.` : `No entry exists at ${target}.`;
}

// {§fs-namespace} {§diagnostic-observation} — every file miss carries this recovery: listing,
// creation and admission stand as alternatives, each valid whatever the address was for.
export const FILE_MISS_RECOVERY = "FIND lists paths. EDIT creates files; `plurnk_members (add)` admits existing files with a `{\"files\": [\"<path>\"]}` body.";

// {§fs-namespace} — a file member renders its literal key as a reusable path;
// every other scheme renders its URI.
export function entryAddress(scheme: string, authority: string, pathname: string, projectRoot: string | null = null): string {
    if (scheme === "file") return FileAddress.render(pathname, projectRoot);
    return renderAddress({ scheme, authority, pathname });
}

// {§fs-namespace} — an address beyond the root (spelled absolute, {§fs-namespace}; a bare
// `../` key where no root renders it) is past every door the miss recovery names under the default scopes; the
// sentence holds under every members scope.
export function fileMissRecovery(address: string): string {
    if (address.startsWith("/") || address === ".." || address.startsWith("../")) {
        return `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`;
    }
    return FILE_MISS_RECOVERY;
}

// The extensions every miss carries: its rendered target, and for a file the recovery above.
export function missExtensions(scheme: string | null, target: string): { readonly target: string; readonly recovery?: string } {
    return scheme === "file" ? { target, recovery: fileMissRecovery(target) } : { target };
}

/** Render one stored target without exposing credentials or request metadata. {§scheme-address} */
export function renderTarget(target: RenderTargetParts, projectRoot: string | null = null, authored: ParsedPath | null = null): string | null {
    if (target.pathname === null || target.pathname === undefined) return null;

    const hostname = target.hostname ?? null;
    const scheme = target.scheme ?? null;
    let address: string;
    if (scheme === null) {
        const key = target.pathname.replace(/^\//, "");
        address = authored !== null && FileAddress.isPattern(authored)
            ? FileAddress.renderSelector(key, authored)
            : entryAddress("file", "", key, projectRoot);
    } else if (hostname !== null && hostname.length > 0) {
        const port = target.port === null || target.port === undefined ? "" : `:${target.port}`;
        address = PathSyntax.escapeTarget(`${scheme}://${hostname}${port}${PathSyntax.encodeParens(target.pathname)}`);
    } else {
        const authority = hostname === null || hostname.length === 0
            ? ""
            : `${hostname}${target.port === null || target.port === undefined ? "" : `:${target.port}`}`;
        address = renderAddress({ scheme, authority, pathname: target.pathname });
    }

    if (target.query !== null && target.query !== undefined) {
        address += `?${PathSyntax.escapeTarget(target.query)}`;
    }
    if (target.fragment !== null && target.fragment !== undefined && target.fragment.length > 0) {
        address += `#${PathSyntax.escapeTarget(target.fragment)}`;
    }
    return address.length === 0 ? null : address;
}

// Authored local syntax is not a bound file identity: it can contain selectors or home expansion.
export function renderAuthoredTarget(target: ParsedPath): string {
    if (target.kind === "url") return renderTarget(target)!;
    const path = PathSyntax.escapeTarget(PathSyntax.encodeParens(target.raw));
    return target.fragment ? `${path}#${PathSyntax.escapeTarget(target.fragment)}` : path;
}
