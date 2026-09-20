// {§scheme-address} — registered non-network scheme authorities mechanically fold
// into the stored pathname. Rendering uses the canonical empty-authority form.
// Network schemes instead restore the stored host to the authority slot.

import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import { EntryCoordinates, NetworkAddress, type EntryCoordinate } from "@plurnk/plurnk-schemes";

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
    // {§scheme-address-network}: handler aliases route https through http and ws through wss
    // without collapsing the addressed scheme's resource identity.
    if (path.kind === "url") {
        return routedSchemeName(path.scheme);
    }
    return "file";  // local (bare) → file
}

export function routedSchemeName(addressedScheme: string): string {
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

// {§worker-generated-subtree}: workspace-generated reference paths.
const GENERATED_ROOT = "/_plurnk";

export function generatedPathname(relative: string): string {
    return `${GENERATED_ROOT}${relative.startsWith("/") ? relative : `/${relative}`}`;
}

export function isGeneratedPathname(pathname: string): boolean {
    return pathname === GENERATED_ROOT || pathname.startsWith(`${GENERATED_ROOT}/`);
}

// {§message-arrival}: opaque identity is independent of arrival order.
export function renderAddress(address: EntryCoordinate & { readonly scheme: string }): string {
    if (NetworkAddress.supports(address.scheme)) return NetworkAddress.render(address);
    const { scheme, authority, pathname } = address;
    const encoded = PathSyntax.encodeParens(pathname);
    return PathSyntax.escapeTarget(`${scheme}://${authority}${encoded}`);
}

// {§membership-read-refusal} — what an address lacks is an entry, and in `file` an entry is a
// member. "No entry exists" reads there as a claim about the disk, which the engine never makes:
// this sentence is about the address's membership and is true whether or not a file is there.
export function missDetail(scheme: string | null, target: string): string {
    return scheme === "file" ? `No member of this workspace is at '${target}'.` : `No entry exists at ${target}.`;
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
