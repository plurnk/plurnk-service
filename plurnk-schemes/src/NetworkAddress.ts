import { PathSyntax, type UrlPath } from "@plurnk/plurnk-contracts";
import type { EntryCoordinate } from "./types.ts";

const NETWORK_SCHEMES = new Set(["http", "https", "ws", "wss"]);

/** Canonical, non-secret identity and transport form for network targets. {§network-address} */
export default class NetworkAddress {
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly url: string;
    readonly hasCredentials: boolean;

    private constructor(target: UrlPath) {
        const scheme = target.scheme.toLowerCase();
        if (!NetworkAddress.supports(scheme)) {
            throw new TypeError(`unsupported network scheme: ${target.scheme}`);
        }
        if (target.hostname === null) {
            throw new TypeError(`${scheme} target requires an authority`);
        }

        const authority = `${target.hostname}${target.port === null ? "" : `:${target.port}`}`;
        const query = target.query === null ? "" : `?${target.query}`;

        this.scheme = scheme;
        this.authority = authority;
        this.pathname = PathSyntax.decodeParens(target.pathname) + query;
        this.url = `${scheme}://${authority}${target.pathname}${query}`;
        this.hasCredentials = target.username !== null || target.password !== null;
    }

    static supports(scheme: string): boolean {
        return NETWORK_SCHEMES.has(scheme.toLowerCase());
    }

    static from(target: UrlPath): NetworkAddress {
        return new NetworkAddress(target);
    }

    static render(address: EntryCoordinate & { readonly scheme: string }): string {
        const { scheme, authority, pathname } = address;
        if (!NetworkAddress.supports(scheme)) {
            throw new TypeError(`unsupported network scheme: ${scheme}`);
        }
        if (authority.length === 0) {
            throw new TypeError("network entry authority must not be empty");
        }
        if (!pathname.startsWith("/")) {
            throw new TypeError("network entry pathname must begin with `/`");
        }
        const queryStart = pathname.indexOf("?");
        const path = queryStart === -1 ? pathname : pathname.slice(0, queryStart);
        const query = queryStart === -1 ? "" : pathname.slice(queryStart);
        return PathSyntax.escapeTarget(
            `${scheme.toLowerCase()}://${authority}${PathSyntax.encodeParens(path)}${query}`,
        );
    }
}
