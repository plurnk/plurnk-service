import { PathSyntax, PlurnkParseError, type ParsedPath, type Position, type UrlPath } from "@plurnk/plurnk-contracts";

const EXPLICIT_URI = /^[a-z][a-z0-9+.-]*:\/\//i;

// WHATWG percent-encodes raw braces. Protect only authored path braces while
// decomposing so brace globs remain distinguishable from authored `%7B`/`%7D`
// literal path data. Query and fragment spelling remain untouched.
const protectPathBraces = (target: string): { value: string; restore: (pathname: string) => string } => {
    const authorityStart = target.indexOf("://") + 3;
    const pathStart = target.indexOf("/", authorityStart);
    if (pathStart < 0) return { value: target, restore: (pathname) => pathname };
    const queryStart = target.indexOf("?", authorityStart);
    const fragmentStart = target.indexOf("#", authorityStart);
    const endings = [queryStart, fragmentStart].filter((index) => index >= 0);
    const pathEnd = endings.length === 0 ? target.length : Math.min(...endings);
    if (pathStart >= pathEnd) return { value: target, restore: (pathname) => pathname };
    const rawPath = target.slice(pathStart, pathEnd);
    if (!/[{}]/u.test(rawPath)) return { value: target, restore: (pathname) => pathname };

    const sentinels: string[] = [];
    for (let codePoint = 0xF0000; sentinels.length < 2; codePoint += 1) {
        const character = String.fromCodePoint(codePoint);
        const encoded = encodeURIComponent(character);
        if (!target.includes(character) && !target.toUpperCase().includes(encoded)) sentinels.push(encoded);
    }
    const [open, close] = sentinels;
    const protectedPath = rawPath.replaceAll("{", open).replaceAll("}", close);
    return {
        value: target.slice(0, pathStart) + protectedPath + target.slice(pathEnd),
        restore: (pathname) => pathname.replaceAll(open, "{").replaceAll(close, "}"),
    };
};

const queryFrom = (url: URL): string | null => {
    const queryStart = url.href.indexOf("?");
    if (queryStart === -1) return null;
    const fragmentStart = url.href.indexOf("#");
    if (fragmentStart !== -1 && fragmentStart < queryStart) return null;
    return url.href.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
};

/**
 * Apply target-slot decomposition without round-tripping through a statement.
 * Returns null for empty input and throws PlurnkParseError when a scheme URL
 * fails WHATWG admission. {§path-syntax}
 */
export const parsePath = (raw: string, pos: Position = { line: 0, column: 0 }): ParsedPath | null => {
    if (raw.length === 0) return null;
    const target = PathSyntax.unescapeTarget(raw);
    if (!EXPLICIT_URI.test(target)) {
        // {§op-shapes} — `#channel` after a bare path is the channel, exactly as on a
        // URL; a spelling that opens with `#` names no path, so it stays whole.
        const hash = target.indexOf("#");
        if (hash < 1) return { kind: "local", raw: target };
        return { kind: "local", raw: target.slice(0, hash), fragment: target.slice(hash + 1) };
    }
    const protectedTarget = protectPathBraces(target);
    let url: URL;
    try {
        url = new URL(protectedTarget.value);
    } catch {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid URI in path", "error",
            "Write a local path, `(src/a.py)`, or a complete URL, `scheme://host/path`.");
    }
    // Uniform WHATWG decomposition — no per-scheme authority allowlist. `://`
    // introduces an authority for every scheme; an authority-less reference
    // writes the empty-authority form `scheme:///path` (host parses empty).
    // Whether a given scheme should carry an authority is a runtime concern,
    // not the grammar's; the parser just reports what the standard parsed.
    const parsed: UrlPath = {
        kind: "url",
        raw: target,
        scheme: url.protocol.replace(/:$/, ""),
        username: url.username || null,
        password: url.password || null,
        hostname: url.hostname || null,
        port: url.port ? Number.parseInt(url.port, 10) : null,
        pathname: protectedTarget.restore(url.pathname),
        query: queryFrom(url),
        fragment: url.hash ? url.hash.slice(1) : null,
    };
    return parsed;
};

const splitTopLevel = (raw: string): string[] => {
    const members: string[] = [];
    let memberStart = 0;
    let braceDepth = 0;

    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (char === "{") {
            braceDepth++;
            continue;
        }
        if (char === "}" && braceDepth > 0) {
            braceDepth--;
            continue;
        }
        if (braceDepth > 0 || (char !== "," && !/\s/u.test(char))) continue;

        const member = raw.slice(memberStart, index).trim();
        if (member.length > 0) members.push(member);
        while (index + 1 < raw.length && (raw[index + 1] === "," || /\s/u.test(raw[index + 1]))) index++;
        memberStart = index + 1;
    }

    const finalMember = raw.slice(memberStart).trim();
    if (finalMember.length > 0) members.push(finalMember);
    return members;
};

// {§slot-order}: only a list of independently valid explicit URIs is unambiguous.
export const targetMembers = (target: ParsedPath): ParsedPath[] => {
    const members = splitTopLevel(target.raw);
    if (members.length < 2 || members.some((member) => !EXPLICIT_URI.test(member))) return [target];

    try {
        const targets = members.map((member) => parsePath(member));
        if (!targets.every((member): member is UrlPath => member?.kind === "url")) return [target];
        return targets;
    } catch (error) {
        if (error instanceof PlurnkParseError) return [target];
        throw error;
    }
};
