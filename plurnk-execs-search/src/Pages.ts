import dns from "node:dns/promises";
import net from "node:net";
import type { ExecArgs } from "@plurnk/plurnk-execs";

// One-load page pass for the search flow (plurnk-execs#18): fetch each SearXNG
// candidate exactly once, prune the dead, and materialize survivors as
// slug-tagged https:// entries via the consumer's ExecArgs.entry() sink.
// Pruning is silent by design — dead results are eliminated, never annotated
// (the rummy heritage: listed = loaded).
//
//   PLURNK_EXECS_SEARCH_PAGE_TIMEOUT  (optional)  ms per page; the exec signal
//                                                 is the deadline (SPEC §2.5),
//                                                 this is an extra per-page ceiling
//   PLURNK_EXECS_SEARCH_REDIRECTS     (optional)  max redirect hops to follow,
//                                                 each hop re-guarded; unset ⇒
//                                                 3xx responses are pruned
//
// Search results are attacker-influencable URLs, so every fetch target — and
// every redirect hop — passes a private-address guard (service#340 flag):
// http(s) only, no localhost, and every resolved address must be public.
// The DNS pre-check is TOCTOU-imperfect (fetch resolves again); the residual
// rebinding sliver is accepted day-one and noted on schemes-http#4, the shared
// fetch-hardening home.
export default class Pages {
    // Deterministic query slug — the tag that ties a search's entries together.
    // Full slugified query, no truncation (no locally-invented length cap).
    static slugify(query: string): string {
        return query.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    // Load one candidate page. Returns true iff the page survived: guard passed,
    // fetch 2xx, textual mimetype, non-empty body, and (when the consumer
    // provides the sink) the entry materialized. Any failure ⇒ false, silently.
    static async load(url: string, { signal, entry, slug }: { signal: AbortSignal; entry: ExecArgs["entry"]; slug: string }): Promise<boolean> {
        const timeoutRaw = process.env.PLURNK_EXECS_SEARCH_PAGE_TIMEOUT;
        const pageSignal = timeoutRaw ? AbortSignal.any([signal, AbortSignal.timeout(Number(timeoutRaw))]) : signal;
        try {
            const response = await Pages.#fetchGuarded(url, pageSignal);
            if (response === null || !response.ok) return false;
            const mimetype = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
            if (!Pages.#isTextual(mimetype)) return false;
            const body = await response.text();
            if (body.trim() === "") return false;
            if (entry) await entry(url, body, { tags: [slug], mimetype });
            return true;
        } catch {
            return false; // unreachable, timed out, aborted, or entry() rejected — pruned
        }
    }

    // Fetch with manual redirects so every hop is re-guarded — a public URL
    // redirecting into private address space is the classic SSRF. Unset
    // REDIRECTS ⇒ zero hops followed (strictest default, no invented number).
    static async #fetchGuarded(raw: string, signal: AbortSignal): Promise<Response | null> {
        let target = raw;
        let hops = Number(process.env.PLURNK_EXECS_SEARCH_REDIRECTS ?? 0);
        while (true) {
            if (!(await Pages.#isPublicUrl(target))) return null;
            const response = await fetch(target, { signal, redirect: "manual" });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");
                if (!location || hops <= 0) return null;
                hops -= 1;
                target = new URL(location, target).href;
                continue;
            }
            return response;
        }
    }

    // Only textual content materializes day-one — binary bodies (pdf, images)
    // would mangle through the string entry() contract. Scope noted on #18.
    static #isTextual(mimetype: string): boolean {
        if (mimetype.startsWith("text/")) return true;
        return ["application/json", "application/xml", "application/xhtml+xml"].includes(mimetype)
            || mimetype.endsWith("+json") || mimetype.endsWith("+xml");
    }

    static async #isPublicUrl(raw: string): Promise<boolean> {
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            return false;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (host === "localhost" || host.endsWith(".localhost")) return false;
        if (net.isIP(host)) return Pages.#isPublicAddress(host);
        try {
            const addrs = await dns.lookup(host, { all: true });
            return addrs.length > 0 && addrs.every(({ address }) => Pages.#isPublicAddress(address));
        } catch {
            return false; // unresolvable is dead anyway
        }
    }

    // RFC-reserved ranges (protocol constants, not tunables): loopback,
    // RFC 1918, link-local/metadata, CGNAT, unspecified; v6 ULA + link-local
    // + v4-mapped re-checked as v4.
    static #isPublicAddress(ip: string): boolean {
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
        const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return Pages.#isPublicAddress(mapped[1]);
        return true;
    }
}
