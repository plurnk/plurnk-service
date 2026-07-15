// SSRF guard for the fetch path (#456; ported from execs-search Pages.ts, which
// deletes its copy as prefetch delegates here — execs #387). Every request —
// the initial target AND every redirect hop — must resolve to a PUBLIC address:
// a public URL redirecting into private space is the classic SSRF, so redirects
// are followed MANUALLY and re-guarded per hop. The residual DNS-rebinding
// sliver (the runtime re-resolves after our check) is accepted day-one, same as
// the reference. Byte path only day-one; the chromium render navigation is a
// separate surface tracked on #456.

import dns from "node:dns/promises";
import net from "node:net";
import { requireNumEnv } from "./Browser.ts";

// A target (or a redirect hop) that resolved to a non-public address. Http maps
// it to a 403 dead-signal, distinct from a network 502.
export class GuardBlockedError extends Error {
    readonly url: string;
    constructor(url: string) {
        super(`SSRF guard: ${url} is not a public http(s) target`);
        this.name = "GuardBlockedError";
        this.url = url;
    }
}

export default class Guard {
    // RFC-reserved ranges (protocol constants, never tunables): loopback,
    // RFC1918, link-local/metadata (169.254), CGNAT (100.64/10), unspecified,
    // 0.0.0.0/8; v6 ULA + link-local + v4-mapped re-checked as v4.
    static isPublicAddress(ip: string): boolean {
        if (net.isIP(ip) === 4) {
            const [a, b] = ip.split(".").map(Number);
            if (a === 0 || a === 10 || a === 127) return false;
            if (a === 169 && b === 254) return false;
            if (a === 172 && b >= 16 && b <= 31) return false;
            if (a === 192 && b === 168) return false;
            if (a === 100 && b >= 64 && b <= 127) return false;
            return true;
        }
        const v6 = ip.toLowerCase();
        if (v6 === "::" || v6 === "::1") return false;
        if (v6.startsWith("fc") || v6.startsWith("fd")) return false;
        if (/^fe[89ab]/.test(v6)) return false;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
        if (mapped !== null) return Guard.isPublicAddress(mapped[1]);
        return true;
    }

    // http(s) only, no localhost, and EVERY resolved address public. An IP
    // literal skips DNS; a hostname resolves and every A/AAAA must be public.
    static async isPublicUrl(raw: string): Promise<boolean> {
        let url: URL;
        try { url = new URL(raw); } catch { return false; }
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
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
    // manually (floor-set knob — unset crashes). Method/body downgrade follows the
    // fetch spec (301/302 on a non-GET/HEAD and any 303 → GET, body dropped;
    // 307/308 preserve). Throws GuardBlockedError on a private hop; hands back the
    // final response (incl. a terminal 3xx when hops run out) otherwise.
    static async fetch(
        raw: string,
        init: { method: string; body: string | undefined; headers: Array<[string, string]> },
        signal: AbortSignal,
    ): Promise<Response> {
        let target = raw;
        let method = init.method;
        let body = init.body;
        let hops = requireNumEnv("PLURNK_SCHEMES_HTTP_REDIRECTS");
        while (true) {
            if (!(await Guard.isPublicUrl(target))) throw new GuardBlockedError(target);
            const response = await fetch(target, { method, body, headers: init.headers, signal, redirect: "manual" });
            if (response.status < 300 || response.status >= 400) return response;
            const location = response.headers.get("location");
            if (location === null || hops <= 0) return response;
            hops -= 1;
            target = new URL(location, target).href;
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
                method = "GET";
                body = undefined;
            }
        }
    }
}
