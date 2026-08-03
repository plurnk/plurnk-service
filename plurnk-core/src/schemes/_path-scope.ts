import { posix } from "node:path";
import { PathSyntax } from "@plurnk/plurnk-contracts";

export type PathScope =
    | { kind: "exact"; pathname: string; candidatePrefix: string }
    | { kind: "folder"; prefix: string; candidatePrefix: string }
    | {
        kind: "glob";
        pattern: string;
        candidatePrefix: string | null;
        shallowPrefix: string | null;
        recursivePrefix: string | null;
    };

export const pathScope = (pathname: string, folderScopes: boolean): PathScope => {
    if (folderScopes && (pathname === "" || pathname.endsWith("/"))) {
        return { kind: "folder", prefix: pathname, candidatePrefix: pathname };
    }
    const magic = PathSyntax.globMagicIndex(pathname);
    if (magic < 0) return { kind: "exact", pathname, candidatePrefix: pathname };
    const candidatePrefix = magic === 0 ? null : pathname.slice(0, magic);
    const shallowPrefix = pathname[magic] === "*" && pathname[magic + 1] !== "*"
        && magic === pathname.length - 1
        ? pathname.slice(0, magic)
        : null;
    const recursivePrefix = pathname.slice(magic) === "**" ? pathname.slice(0, magic) : null;
    return { kind: "glob", pattern: pathname, candidatePrefix, shallowPrefix, recursivePrefix };
};

export const pathScopeMatches = (scope: PathScope, pathname: string): boolean => {
    if (scope.kind === "exact") return pathname === scope.pathname;
    if (scope.kind === "folder") return pathname.startsWith(scope.prefix);
    // Terminal `*` and `**` are the structural catalog selectors. They include
    // dot entries so the promised complete map cannot hide `.env.defaults` or
    // `.github`; richer shell patterns retain Node's native dotfile behavior.
    if (scope.shallowPrefix !== null) {
        if (!pathname.startsWith(scope.shallowPrefix)) return false;
        const remainder = pathname.slice(scope.shallowPrefix.length);
        return remainder.length > 0 && !remainder.includes("/");
    }
    if (scope.recursivePrefix !== null) return pathname.startsWith(scope.recursivePrefix);
    return posix.matchesGlob(pathname, scope.pattern);
};

export type PathFolderSummary = {
    selector: string;
    pathnames: string[];
};

// A terminal single-star glob is a one-level catalog. Real entries at that
// level remain ordinary results; deeper entries collapse under an actionable
// `dir/**` selector that describes exactly the subtree being summarized.
export const pathFolderSummaries = (
    scope: PathScope,
    pathnames: readonly string[],
): PathFolderSummary[] => {
    if (scope.kind !== "glob" || scope.shallowPrefix === null) return [];
    const bySelector = new Map<string, string[]>();
    for (const pathname of pathnames) {
        if (!pathname.startsWith(scope.shallowPrefix)) continue;
        const remainder = pathname.slice(scope.shallowPrefix.length);
        const slash = remainder.indexOf("/");
        if (slash < 0) continue;
        const selector = `${scope.shallowPrefix}${remainder.slice(0, slash + 1)}**`;
        const members = bySelector.get(selector);
        if (members === undefined) bySelector.set(selector, [pathname]);
        else members.push(pathname);
    }
    return [...bySelector.entries()]
        .map(([selector, members]) => ({ selector, pathnames: members }))
        .toSorted((a, b) => a.selector.localeCompare(b.selector));
};
