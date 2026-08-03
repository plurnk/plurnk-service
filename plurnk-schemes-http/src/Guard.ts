// {§http-security-boundary} — every initial HTTP target and redirect hop must
// resolve only to ordinary globally reachable unicast addresses. Redirects are
// followed manually so validation and Fetch-standard request transitions share
// one transport seam.

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

// A target (or redirect hop) forbidden by the public-network policy. Consumers
// map this nonretryable refusal to their own scheme Problem.
export class GuardBlockedError extends Error {
    readonly url: string;
    constructor(url: string) {
        const sanitized = safeUrl(url);
        super(`Network guard: ${sanitized} is not an admissible public network target`);
        this.name = "GuardBlockedError";
        this.url = sanitized;
    }
}

// DNS could not produce an address verdict. This is an operational resolution
// failure, not proof that the target violates policy; consumers therefore keep
// it distinct and retryable. The URL is safe for model-facing projection while
// the exact resolver cause remains daemon-side evidence.
export class GuardResolutionError extends Error {
    readonly url: string;
    constructor(url: string, cause: unknown) {
        const sanitized = safeUrl(url);
        super(`Network guard: DNS resolution failed for ${sanitized}`, { cause });
        this.name = "GuardResolutionError";
        this.url = sanitized;
    }
}

export type GuardAdmission =
    | { readonly admitted: true }
    | { readonly admitted: false; readonly error: GuardBlockedError | GuardResolutionError };

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

    // One admission verdict for http(s)/ws(s): no userinfo or localhost, and
    // EVERY resolved address public. IP literals skip DNS. Policy refusal and
    // inability to obtain a DNS answer are deliberately different outcomes.
    static async admit(raw: string): Promise<GuardAdmission> {
        let url: URL;
        try { url = new URL(raw); } catch { return { admitted: false, error: new GuardBlockedError(raw) }; }
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
            return { admitted: false, error: new GuardBlockedError(url.href) };
        }
        if (url.username !== "" || url.password !== "") {
            return { admitted: false, error: new GuardBlockedError(url.href) };
        }
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (host === "localhost" || host.endsWith(".localhost")) {
            return { admitted: false, error: new GuardBlockedError(url.href) };
        }
        if (net.isIP(host)) return Guard.isPublicAddress(host)
            ? { admitted: true }
            : { admitted: false, error: new GuardBlockedError(url.href) };
        try {
            const addrs = await dns.lookup(host, { all: true });
            if (addrs.length === 0) {
                return {
                    admitted: false,
                    error: new GuardResolutionError(
                        url.href,
                        new Error(`DNS lookup returned no addresses for ${host}`),
                    ),
                };
            }
            return addrs.every(({ address }) => Guard.isPublicAddress(address))
                ? { admitted: true }
                : { admitted: false, error: new GuardBlockedError(url.href) };
        } catch (cause) {
            return { admitted: false, error: new GuardResolutionError(url.href, cause) };
        }
    }

    // Guarded fetch: re-guard every hop, follow up to PLURNK_SCHEMES_HTTP_REDIRECTS
    // manually (floor-set knob — unset crashes). Method, body, body headers, and
    // cross-origin Authorization follow WHATWG HTTP-redirect fetch. Throws the
    // exact typed admission error on a refused or unresolved hop;
    // hands back the final response (including a terminal redirect when hops
    // run out) otherwise.
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
            if (!["http:", "https:"].includes(current.protocol)) throw new GuardBlockedError(current.href);
            const admission = await Guard.admit(current.href);
            if (!admission.admitted) throw admission.error;
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
