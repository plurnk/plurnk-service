// {§http-security-boundary} — every initial HTTP target and redirect hop must
// resolve only to ordinary globally reachable unicast addresses. Redirects are
// followed manually so validation and Fetch-standard request transitions share
// one transport seam. Connection-time DNS binding remains isolated as #117.

import dns from "node:dns/promises";
import net from "node:net";
import { requireNumEnv } from "./Browser.ts";

const BLOCKED = new net.BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
] as const) BLOCKED.addSubnet(network, prefix, "ipv6");

const IPV4_MAPPED = new net.BlockList();
IPV4_MAPPED.addSubnet("0.0.0.0", 0, "ipv4");
const GLOBAL_IPV6 = new net.BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set(["content-encoding", "content-language", "content-location", "content-type"]);
const AUTHORIZATION_HEADERS = new Set(["authorization"]);

const withoutHeaders = (
    headers: ReadonlyArray<readonly [string, string]>,
    names: ReadonlySet<string>,
): Array<[string, string]> => headers
    .filter(([name]) => !names.has(name.toLowerCase()))
    .map(([name, value]) => [name, value]);

const safeUrl = (raw: string): string => {
    try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        return url.href;
    } catch {
        return raw;
    }
};

// A target (or a redirect hop) that resolved to a non-public address. Http maps
// it to a 403 dead-signal, distinct from a network 502.
export class GuardBlockedError extends Error {
    readonly url: string;
    constructor(url: string) {
        const sanitized = safeUrl(url);
        super(`SSRF guard: ${sanitized} is not a public http(s) target`);
        this.name = "GuardBlockedError";
        this.url = sanitized;
    }
}

export default class Guard {
    // Static protocol ranges, not operator policy. IPv4-mapped IPv6 is checked
    // against the same v4 block list after WHATWG URL canonicalization.
    static isPublicAddress(ip: string): boolean {
        const family = net.isIP(ip);
        if (family === 0) return false;
        if (family === 4) return !BLOCKED.check(ip, "ipv4");
        if (IPV4_MAPPED.check(ip, "ipv6")) return !BLOCKED.check(ip, "ipv6");
        return GLOBAL_IPV6.check(ip, "ipv6") && !BLOCKED.check(ip, "ipv6");
    }

    // http(s)/ws(s) only, no localhost, and EVERY resolved address public. An IP
    // literal skips DNS; a hostname resolves and every A/AAAA must be public.
    // ws:/wss: ride the same range check — a WebSocket into private space is the
    // same SSRF as a fetch (the Ws scheme guards its target through here).
    static async isPublicUrl(raw: string): Promise<boolean> {
        let url: URL;
        try { url = new URL(raw); } catch { return false; }
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
        if (url.username !== "" || url.password !== "") return false;
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (host === "localhost" || host.endsWith(".localhost")) return false;
        if (net.isIP(host)) return Guard.isPublicAddress(host);
        try {
            const addrs = await dns.lookup(host, { all: true });
            return addrs.length > 0 && addrs.every(({ address }) => Guard.isPublicAddress(address));
        } catch {
            return false; // unresolvable is dead anyway
        }
    }

    // Guarded fetch: re-guard every hop, follow up to PLURNK_SCHEMES_HTTP_REDIRECTS
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
        let hops = requireNumEnv("PLURNK_SCHEMES_HTTP_REDIRECTS");
        while (true) {
            let current: URL;
            try { current = new URL(target); } catch { throw new GuardBlockedError(target); }
            if (!["http:", "https:"].includes(current.protocol) || !(await Guard.isPublicUrl(current.href))) {
                throw new GuardBlockedError(current.href);
            }
            const response = await fetch(current.href, { method, body, headers, signal, redirect: "manual" });
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
