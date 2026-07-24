// The guarded acquisition primitive core's entrySink calls (#454). The byte
// response is primary; HTML carries a lazy guarded browser fallback for core
// to invoke only when MIME projection is empty. Dead-ness is a value, never a
// throw — null covers SSRF-refused, unreachable, non-2xx, non-textual, and empty.

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
    close?(): Promise<void>;
}

export interface WebFetchResult {
    body: string;
    mimetype: string;
    // Canonical response metadata channel, including the materialization stamp
    // direct Http READ uses for TTL/conditional revalidation.
    header?: string;
    // HTML byte responses are authoritative when their model-facing MIME
    // projection is useful. Core calls this guarded browser acquisition only
    // when that projection is empty.
    render?: () => Promise<{ body: string; mimetype: string } | null>;
}

export default class WebFetcher {
    // One warm-Chromium pool shared across prefetches (render context keyed 0 —
    // prefetch is public-page acquisition, no per-worker cookie isolation to keep).
    readonly #browser: Renderer;
    constructor(browser: Renderer = new Browser()) {
        this.#browser = browser;
    }

    async close(): Promise<void> {
        await this.#browser.close?.();
    }

    async fetch(url: string, opts?: { signal?: AbortSignal }): Promise<WebFetchResult | null> {
        // Bound the byte probe independently. Browser.render owns its own
        // navigation timeout and must be allowed to observe Playwright's
        // TimeoutError so Browser.#safeGoto can salvage an already-rendered DOM.
        // Sharing this timeout with render used to close the page at the exact
        // same instant as goto timed out, converting salvageable news pages into
        // "Target closed" and returning null (#596).
        const probeTimeout = AbortSignal.timeout(requireNumEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT"));
        const probeSignal = opts?.signal ? AbortSignal.any([opts.signal, probeTimeout]) : probeTimeout;

        let response: Response;
        try {
            response = await Guard.fetch(url, { method: "GET", body: undefined, headers: [["User-Agent", BROWSER_UA]] }, probeSignal);
        } catch {
            return null; // SSRF-refused or unreachable — both dead
        }
        const mimetype = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!response.ok) { await response.body?.cancel(); return null; } // non-2xx dead
        const header = WebFetcher.#header(response);

        // Preserve server-rendered HTML as the primary acquisition. The MIME
        // layer decides whether its model-facing projection is useful; only an
        // empty projection invokes the lazy browser fallback. Unconditionally
        // rendering valid SSR pages is slower and can mutate the DOM until
        // Readability selects unrelated feed/chrome content (#596).
        if (isHtml(mimetype)) {
            const body = await response.text();
            if (body.length === 0) return null;
            return {
                body,
                mimetype,
                header,
                render: async () => {
                    try {
                        const rendered = await this.#browser.render(url, {
                            workerId: 0,
                            // Caller cancellation still spans the whole operation.
                            // The renderer supplies its own per-navigation deadline.
                            signal: opts?.signal,
                            headers: [["User-Agent", BROWSER_UA]],
                            guard: Guard.isPublicUrl,
                        });
                        return rendered.html.length > 0 ? { body: rendered.html, mimetype: "text/html" } : null;
                    } catch {
                        return null;
                    }
                },
            };
        }

        if (!isTextual(mimetype)) { await response.body?.cancel(); return null; } // binary pruned
        const body = await response.text();
        return body.length > 0 ? { body, mimetype, header } : null; // empty is dead
    }

    static #header(response: Response): string {
        return [
            `HTTP ${response.status} ${response.statusText}`,
            ...[...response.headers].map(([key, value]) => `${key}: ${value}`),
            `x-plurnk-fetched-at: ${new Date().toISOString()}`,
        ].join("\n");
    }
}
