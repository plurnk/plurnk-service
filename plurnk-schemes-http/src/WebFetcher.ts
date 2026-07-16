// The guarded fetch/render prefetch primitive core's entrySink calls (#454).
// ONE seam (SPEC §prefetch): `fetch(url) → { body, mimetype } | null`. Dead-ness is a VALUE,
// never a throw — null covers SSRF-refused, unreachable, non-2xx, non-textual,
// and empty. Everything behind it (plain fetch vs playwright/salvage, redirect
// hops, per-page timeout, the SSRF guard) is ours.

import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import Guard from "./Guard.ts";

// Day-one textual set (owner ruling, #454): text/* plus the +json/+xml family.
// Non-textual bodies (pdf, images) prune to null — they don't survive the
// string entry() contract core prefetches into.
const isTextual = (mimetype: string): boolean =>
    mimetype.startsWith("text/")
    || ["application/json", "application/xml", "application/xhtml+xml"].includes(mimetype)
    || mimetype.endsWith("+json") || mimetype.endsWith("+xml");

const isHtml = (mimetype: string): boolean =>
    mimetype === "text/html" || mimetype === "application/xhtml+xml";

// What the primitive needs from the render foundation — narrow, so tests inject.
interface Renderer {
    render(url: string, opts: {
        workerId: number;
        signal?: AbortSignal;
        headers?: ReadonlyArray<readonly [string, string]>;
        guard?: (url: string) => Promise<boolean>;
    }): Promise<RenderResult>;
}

export default class WebFetcher {
    // One warm-Chromium pool shared across prefetches (render context keyed 0 —
    // prefetch is public-page acquisition, no per-run cookie isolation to keep).
    readonly #browser: Renderer;
    constructor(browser: Renderer = new Browser()) {
        this.#browser = browser;
    }

    async fetch(url: string, opts?: { signal?: AbortSignal }): Promise<{ body: string; mimetype: string } | null> {
        const timeout = AbortSignal.timeout(requireNumEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT"));
        const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

        let response: Response;
        try {
            response = await Guard.fetch(url, { method: "GET", body: undefined, headers: [["User-Agent", BROWSER_UA]] }, signal);
        } catch {
            return null; // SSRF-refused or unreachable — both dead
        }
        const mimetype = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!response.ok) { await response.body?.cancel(); return null; } // non-2xx dead

        // HTML → render (playwright/salvage); the guard re-checks every navigation
        // and subresource, so a public page redirecting into private space is
        // refused at the browser too, not just the probe fetch.
        if (isHtml(mimetype)) {
            await response.body?.cancel();
            try {
                const rendered = await this.#browser.render(url, {
                    workerId: 0,
                    signal,
                    headers: [["User-Agent", BROWSER_UA]],
                    guard: Guard.isPublicUrl,
                });
                return rendered.html.length > 0 ? { body: rendered.html, mimetype: "text/html" } : null;
            } catch {
                return null; // render failure (nav error, timeout, guard-aborted) is dead
            }
        }

        if (!isTextual(mimetype)) { await response.body?.cancel(); return null; } // binary pruned
        const body = await response.text();
        return body.length > 0 ? { body, mimetype } : null; // empty is dead
    }
}
