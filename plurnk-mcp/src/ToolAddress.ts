import type { ParsedPath } from "@plurnk/plurnk-schemes";

const encodeAuthority = (value: string): string => encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
);

const isBareAuthorityResource = (target: ParsedPath): target is Extract<ParsedPath, { kind: "url" }> =>
    target.kind === "url"
    && target.hostname !== null
    && target.pathname === "/"
    && target.username === null
    && target.password === null
    && target.port === null
    && target.query === null
    && target.fragment === null
    && target.headers === undefined;

export default class ToolAddress {
    static render(server: string, name: string): string {
        if (name.length === 0) throw new TypeError("MCP tool names must not be empty.");
        return `${server}://${encodeAuthority(name)}/`;
    }

    static isCatalog(target: ParsedPath): boolean {
        return isBareAuthorityResource(target) && target.hostname === "*";
    }

    static name(target: ParsedPath): string | null {
        const hostname = target.kind === "url" ? target.hostname : null;
        if (!isBareAuthorityResource(target) || hostname === null || ToolAddress.isCatalog(target)) return null;
        try {
            const name = decodeURIComponent(hostname);
            return encodeAuthority(name) === hostname ? name : null;
        } catch {
            return null;
        }
    }

    static internalPath(name: string): string {
        return `/tools/${encodeAuthority(name)}`;
    }
}
