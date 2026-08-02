// Operator path matcher ({§mimetype-search-exclusion}). This layer has no
// scheme identity; #91 owns moving file-search policy to one scheme-aware path.

import { globToRegex } from "./query.ts";

const cache = new Map<string, { source: string; regex: RegExp }[]>();

function compile(raw: string): { source: string; regex: RegExp }[] {
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const patterns = raw.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((source) => ({ source, regex: globToRegex(source) }));
    cache.set(raw, patterns);
    return patterns;
}

// Read at call time so host environment changes are immediately observable.
export function matchSearchExclusion(path: string | undefined): string | undefined {
    if (path === undefined) return undefined;
    const raw = process.env.PLURNK_MIMETYPES_SEARCH_EXCLUDE;
    if (raw === undefined || raw.trim() === "") return undefined;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return compile(raw).find((p) => p.regex.test(p.source.includes("/") ? path : base))?.source;
}
