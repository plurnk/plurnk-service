// Guarded entry-acquisition primitive {§prefetch}. The byte response is primary;
// HTML carries a lazy browser fallback for the consumer to invoke only when its
// readable projection is empty. Top-level deadness is the `null` value.

import { MimetypeClassifier } from "@plurnk/plurnk-schemes";
import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import Guard from "./Guard.ts";

const isHtml = (mimetype: string): boolean =>
    mimetype === "text/html" || mimetype === "application/xhtml+xml";

// {§host-rewrite} — one transport-only policy for acquisition GETs. Callers
// retain the addressed URL as entry identity; mutations never pass through it.
export const rewriteAcquisitionTarget = (url: string): string => {
    const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
    return gh === null
        ? url
        : `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
};

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
        const target = rewriteAcquisitionTarget(url);
        // Bound the byte probe independently. Browser.render owns its navigation
        // deadline so it can apply the substantive-DOM timeout salvage contract.
        const probeTimeout = AbortSignal.timeout(requireNumEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT"));
        const probeSignal = opts?.signal ? AbortSignal.any([opts.signal, probeTimeout]) : probeTimeout;

        let response: Response;
        try {
            response = await Guard.fetch(target, { method: "GET", body: undefined, headers: [["User-Agent", BROWSER_UA]] }, probeSignal);
        } catch {
            return null; // SSRF-refused or unreachable — both dead
        }
        const mimetype = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
            || "application/octet-stream";
        if (!response.ok) { await response.body?.cancel(); return null; } // non-2xx dead
        const header = WebFetcher.#header(response);

        // Preserve server HTML as primary. Eager rendering can mutate already
        // useful content; the consumer alone decides whether projection is empty.
        if (isHtml(mimetype)) {
            const body = await response.text();
            if (body.length === 0) return null;
            return {
                body,
                mimetype,
                header,
                render: async () => {
                    try {
                        const rendered = await this.#browser.render(target, {
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

        // {§prefetch}/{§mimetype-classifier} Query preparation admits only the
        // shared textual family; binary responses have no string entry value.
        if (MimetypeClassifier.isBinary(mimetype)) { await response.body?.cancel(); return null; }
        const body = await response.text();
        return body.length > 0 ? { body, mimetype, header } : null; // empty is dead
    }

    static #header(response: Response): string {
        return [
            `HTTP ${response.status} ${response.statusText}`,
            ...[...response.headers].map(([key, value]) => `${key}: ${value}`),
            "x-plurnk-request-method: GET",
            `x-plurnk-fetched-at: ${new Date().toISOString()}`,
        ].join("\n");
    }
}
