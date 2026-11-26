import { globToRegex } from "@plurnk/plurnk-mimetypes/runtime";

type SearchIdentity = {
    scheme: string;
    pathname: string;
};

let cached: { readonly raw: string; readonly patterns: { source: string; regex: RegExp }[] } | null = null;

function compile(raw: string): { source: string; regex: RegExp }[] {
    if (cached !== null && cached.raw === raw) return cached.patterns;
    const patterns = raw.split(",")
        .map((source) => source.trim())
        .filter((source) => source.length > 0)
        .map((source) => ({ source, regex: globToRegex(source) }));
    cached = { raw, patterns };
    return patterns;
}

export default function matchSearchExclusion({ scheme, pathname }: SearchIdentity): string | undefined {
    if (scheme !== "file") return undefined;
    const raw = process.env.PLURNK_SERVICE_SEARCH_EXCLUDE;
    if (raw === undefined || raw.trim() === "") return undefined;
    const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
    return compile(raw).find(({ source, regex }) => regex.test(source.includes("/") ? pathname : basename))?.source;
}

// {§persistent-search-index} — a body larger than PLURNK_SERVICE_SEARCH_MAX_BYTES is never parsed or
// full-text indexed. Empty (the default) = unbounded. The reason names the bound.
export function sizeExclusion(contentLength: number): string | undefined {
    const raw = process.env.PLURNK_SERVICE_SEARCH_MAX_BYTES;
    if (raw === undefined || raw.trim() === "") return undefined;
    const bound = Number(raw);
    if (!Number.isSafeInteger(bound) || bound <= 0) {
        throw new RangeError(`PLURNK_SERVICE_SEARCH_MAX_BYTES must be a positive integer or empty; got ${JSON.stringify(raw)}`);
    }
    return contentLength > bound ? `larger than ${bound} bytes` : undefined;
}
