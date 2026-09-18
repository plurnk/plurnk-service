import { globToRegex } from "@plurnk/plurnk-mimetypes";

type SearchIdentity = {
    scheme: string;
    pathname: string;
};

const cache = new Map<string, { source: string; regex: RegExp }[]>();

function compile(raw: string): { source: string; regex: RegExp }[] {
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const patterns = raw.split(",")
        .map((source) => source.trim())
        .filter((source) => source.length > 0)
        .map((source) => ({ source, regex: globToRegex(source) }));
    cache.set(raw, patterns);
    return patterns;
}

export default function matchSearchExclusion({ scheme, pathname }: SearchIdentity): string | undefined {
    if (scheme !== "file") return undefined;
    const raw = process.env.PLURNK_SERVICE_SEARCH_EXCLUDE;
    if (raw === undefined || raw.trim() === "") return undefined;
    const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
    return compile(raw).find(({ source, regex }) => regex.test(source.includes("/") ? pathname : basename))?.source;
}

// {§search-size-bound} — a body larger than PLURNK_SERVICE_SEARCH_MAX_BYTES is never parsed or
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
