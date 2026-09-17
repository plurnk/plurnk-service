import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import type { EntryCoordinate, SchemeAuthority } from "./types.ts";

// {§scheme-address} One address algebra for Core and scheme handlers.
export default class EntryCoordinates {
    static foldAuthority(hostname: string | null, pathname: string): string {
        return hostname ? `/${hostname}${pathname}` : pathname;
    }

    static resolve(path: ParsedPath, authority: SchemeAuthority): EntryCoordinate {
        if (path.kind === "local") return { authority: "", pathname: PathSyntax.decodeParens(path.raw) };
        if (authority === "resource") {
            return {
                authority: path.hostname === null ? "" : `${path.hostname}${path.port === null ? "" : `:${path.port}`}`,
                pathname: PathSyntax.decodeParens(path.pathname) + (path.query === null ? "" : `?${path.query}`),
            };
        }
        return { authority: "", pathname: PathSyntax.decodeParens(EntryCoordinates.foldAuthority(path.hostname, path.pathname)) };
    }
}
