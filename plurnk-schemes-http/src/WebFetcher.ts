// Guarded entry-acquisition primitive {§prefetch}. The byte response is primary;
// HTML carries a lazy browser fallback for the consumer to invoke only when its
// readable projection is absent. Top-level deadness is the `null` value.

import { MimetypeClassifier, type ProjectionCaps } from "@plurnk/plurnk-schemes";
import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import Guard from "./Guard.ts";

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
    // projection is present. Core calls this guarded browser acquisition only
    // when that projection is absent.
    render?: () => Promise<{ body: string; mimetype: string } | null>;
}

export interface WebMaterializedResult {
    readonly body: { content: string; mimetype: string };
    readonly html?: { content: string; mimetype: string };
}

export default class WebFetcher {
    // One warm-Chromium pool shared across prefetches (render context keyed 0 —
    // prefetch is public-page acquisition, no per-worker cookie isolation to keep).
    readonly #browser: Renderer;
    constructor(browser: Renderer = new Browser()) {
        this.#browser = browser;
    }

    // {§html-materialization} One projection seam for exact HTTP preparation
    // and executor entry acquisition. A present empty projection is valid;
    // only null asks the lazy renderer or reports final absence.
    static async materialize(
        fetched: Pick<WebFetchResult, "body" | "mimetype" | "render">,
        projection: ProjectionCaps,
    ): Promise<WebMaterializedResult | null> {
        if (!MimetypeClassifier.isHtml(fetched.mimetype)) {
            return { body: { content: fetched.body, mimetype: fetched.mimetype } };
        }
        let html = { content: fetched.body, mimetype: fetched.mimetype };
        let projected = await projection.readable(html.content, html.mimetype);
        if (projected === null && fetched.render !== undefined) {
            const rendered = await fetched.render();
            if (rendered !== null) {
                html = { content: rendered.body, mimetype: rendered.mimetype };
                projected = await projection.readable(html.content, html.mimetype);
            }
        }
        return projected === null ? null : { body: projected, html };
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
        // useful content; the consumer alone decides whether projection is absent.
        if (MimetypeClassifier.isHtml(mimetype)) {
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
