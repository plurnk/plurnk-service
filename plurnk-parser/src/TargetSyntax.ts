import { PathSyntax, PlurnkParseError, type ParsedPath, type Position, type UrlPath } from "@plurnk/plurnk-contracts";

const EXPLICIT_URI = /^[a-z][a-z0-9+._-]*:\/\//i;

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
    const schemeEnd = target.indexOf("://");
    const scheme = target.slice(0, schemeEnd).toLowerCase();
    const protectedTarget = protectPathBraces(`${scheme.replaceAll("_", "-")}${target.slice(schemeEnd)}`);
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
        scheme,
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
        if (braceDepth > 0 || (char !== "," && char !== "|" && !/\s/u.test(char))) continue;

        const member = raw.slice(memberStart, index).trim();
        if (member.length > 0) members.push(member);
        while (index + 1 < raw.length && (raw[index + 1] === "," || raw[index + 1] === "|" || /\s/u.test(raw[index + 1]))) index++;
        memberStart = index + 1;
    }

    const finalMember = raw.slice(memberStart).trim();
    if (finalMember.length > 0) members.push(finalMember);
    return members;
};

const splitLocalTargets = (raw: string): string[] | null => {
    const members: string[] = [];
    let memberStart = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let parenDepth = 0;
    let unspacedComma = false;

    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (char === "\\") {
            index++;
            continue;
        }
        if (char === "{") { braceDepth++; continue; }
        if (char === "}" && braceDepth > 0) { braceDepth--; continue; }
        if (char === "[") { bracketDepth++; continue; }
        if (char === "]" && bracketDepth > 0) { bracketDepth--; continue; }
        if (char === "(") { parenDepth++; continue; }
        if (char === ")" && parenDepth > 0) { parenDepth--; continue; }
        if (braceDepth > 0 || bracketDepth > 0 || parenDepth > 0) continue;
        if (char !== "," && char !== "|") continue;

        const member = raw.slice(memberStart, index).trim();
        if (member.length === 0) return null;
        if (char === "," && !/\s/u.test(raw[index + 1] ?? "")) unspacedComma = true;
        members.push(member);
        memberStart = index + 1;
    }

    if (members.length === 0) return null;
    const finalMember = raw.slice(memberStart).trim();
    if (finalMember.length === 0) return null;
    members.push(finalMember);

    if (members.some((member) => /\s/u.test(member) || member.includes(":"))) return null;
    if (unspacedComma && members.some((member) => !member.includes("/") && !member.includes("*"))) return null;
    return members;
};

// {§slot-order}: an explicit URI list or a comma/pipe-separated local path/glob list compiles in member order.
export const targetMembers = (target: ParsedPath): ParsedPath[] => {
    if (target.kind === "local") {
        const hasSplitFragment = target.fragment != null && /[,|]/u.test(target.fragment);
        const source = hasSplitFragment ? `${target.raw}#${target.fragment}` : target.raw;
        const local = splitLocalTargets(source);
        if (local === null) return [target];
        const sharedFragment = hasSplitFragment ? undefined : target.fragment;
        return local.map((member): ParsedPath => {
            const parsed = parsePath(member)!;
            return sharedFragment != null && parsed.fragment == null
                ? { ...parsed, fragment: sharedFragment }
                : parsed;
        });
    }
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
