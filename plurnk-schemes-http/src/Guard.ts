// {§http-host-policy} — WebFetcher's initial byte target and every
// redirect hop must resolve only to ordinary globally reachable unicast
// addresses. Redirects are followed manually so checking and Fetch-standard
// request transitions share one automatic-acquisition seam.

import {
    GuardBlockedError,
    Knob,
    isPublicAddress,
    isPublicUrl,
    outboundFetch,
} from "@plurnk/plurnk-meta";

export { GuardBlockedError };

// {§http-host-policy} — the operator may confine every web acquisition to named hosts. Unset (or
// empty) admits every host, as before; a JSON array admits exactly its members: `"example.com"`
// names that host, `"*.example.com"` any subdomain of it, and `[]` names none. It is operator
// policy beside {§http-host-policy}, never a model-facing teaching; an isolated benchmark sets [].
const HOSTS_ENV = "PLURNK_SCHEMES_HTTP_HOSTS";

export class HostPolicy {
    // null: no policy (every host); otherwise the admitted patterns.
    static patterns(): readonly string[] | null {
        const raw = process.env[HOSTS_ENV];
        if (raw === undefined || raw.trim() === "") return null;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (cause) { throw new Error(`${HOSTS_ENV} must be a JSON array of host names`, { cause }); }
        if (!Array.isArray(parsed) || !parsed.every((host) => typeof host === "string" && host.length > 0)) {
            throw new Error(`${HOSTS_ENV} must be a JSON array of host names`);
        }
        return parsed.map((host: string) => host.toLowerCase());
    }

    static permits(raw: string): boolean {
        const patterns = HostPolicy.patterns();
        if (patterns === null) return true;
        let host: string;
        try { host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
        catch { return false; }
        return patterns.some((pattern) => pattern.startsWith("*.")
            ? host.endsWith(pattern.slice(1))
            : host === pattern);
    }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set(["content-encoding", "content-language", "content-location", "content-type"]);
const AUTHORIZATION_HEADERS = new Set(["authorization"]);

const withoutHeaders = (
    headers: ReadonlyArray<readonly [string, string]>,
    names: ReadonlySet<string>,
): Array<[string, string]> => headers
    .filter(([name]) => !names.has(name.toLowerCase()))
    .map(([name, value]) => [name, value]);

export default class Guard {
    static isPublicAddress(ip: string): boolean {
        return isPublicAddress(ip);
    }

    static isPublicUrl(raw: string): Promise<boolean> {
        return isPublicUrl(raw);
    }

    // Automatic and public-only fetch: re-check every hop, follow up to PLURNK_SCHEMES_HTTP_REDIRECTS
    // manually (floor-set knob — unset crashes). Method, body, body headers, and
    // cross-origin Authorization follow WHATWG HTTP-redirect fetch. Throws
    // GuardBlockedError on a non-public hop; hands back the final response
    // (including a terminal redirect when hops run out) otherwise.
    static async fetch(
        raw: string,
        init: { method: string; body: string | undefined; headers: ReadonlyArray<readonly [string, string]> },
        signal: AbortSignal,
    ): Promise<Response> {
        let target = raw;
        let method = init.method;
        let body = init.body;
        let headers = init.headers.map(([name, value]): [string, string] => [name, value]);
        let hops = Knob.integer("PLURNK_SCHEMES_HTTP_REDIRECTS", 0);
        while (true) {
            let current: URL;
            try { current = new URL(target); } catch { throw new GuardBlockedError(target); }
            // {§http-host-policy} — every hop, not just the first, stays inside the operator's hosts.
            if (!["http:", "https:"].includes(current.protocol) || !HostPolicy.permits(current.href) || !(await Guard.isPublicUrl(current.href))) {
                throw new GuardBlockedError(current.href);
            }
            const response = await outboundFetch(current.href, { method, body, headers, signal, redirect: "manual" });
            if (!REDIRECT_STATUSES.has(response.status)) return response;
            const location = response.headers.get("location");
            if (location === null || hops <= 0) return response;
            await response.body?.cancel();
            hops -= 1;
            const next = new URL(location, current);
            if (((response.status === 301 || response.status === 302) && method === "POST")
                || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
                method = "GET";
                body = undefined;
                headers = withoutHeaders(headers, BODY_HEADERS);
            }
            if (current.origin !== next.origin) headers = withoutHeaders(headers, AUTHORIZATION_HEADERS);
            target = next.href;
        }
    }
}
