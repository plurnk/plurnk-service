// Guarded entry-acquisition primitive {§prefetch}. The byte response is primary;
// HTML carries a lazy browser fallback for the consumer to invoke only when its
// readable projection is absent. Post-admission deadness is the `null` value;
// typed admission failure and caller cancellation reject.

import { MimetypeClassifier, type ProjectionCaps } from "@plurnk/plurnk-schemes";
import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import Guard, {
    GuardBlockedError,
    GuardResolutionError,
    type GuardAdmission,
} from "./Guard.ts";

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
        guard?: (url: string) => Promise<GuardAdmission>;
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
    // when that projection is absent. Null means no rendered HTML; a render
    // failure rejects with its cause.
    render?: () => Promise<{ body: string; mimetype: string } | null>;
}

export interface WebMaterializedResult {
    readonly body: { content: string; mimetype: string };
    readonly html?: { content: string; mimetype: string };
}

// {§html-materialization} Preserve the failing stage and original cause while
// keeping an expected absent projection in the ordinary null result channel.
export class WebMaterializationError extends Error {
    readonly stage: "projection" | "render";
    readonly mimetype: string;

    constructor(stage: "projection" | "render", mimetype: string, cause: unknown) {
        super(`Web ${stage} failed for ${mimetype}.`, { cause });
        this.name = "WebMaterializationError";
        this.stage = stage;
        this.mimetype = mimetype;
    }
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
    // only null asks the lazy renderer or reports final absence. Projection and
    // render exceptions retain their causes in WebMaterializationError.
    static async materialize(
        fetched: Pick<WebFetchResult, "body" | "mimetype" | "render">,
        projection: ProjectionCaps,
    ): Promise<WebMaterializedResult | null> {
        if (!MimetypeClassifier.isHtml(fetched.mimetype)) {
            return { body: { content: fetched.body, mimetype: fetched.mimetype } };
        }
        let html = { content: fetched.body, mimetype: fetched.mimetype };
        let projected = await WebFetcher.#project(html, projection);
        if (projected === null && fetched.render !== undefined) {
            let rendered: Awaited<ReturnType<NonNullable<WebFetchResult["render"]>>>;
            try {
                rendered = await fetched.render();
            } catch (cause) {
                throw new WebMaterializationError("render", html.mimetype, cause);
            }
            if (rendered !== null) {
                html = { content: rendered.body, mimetype: rendered.mimetype };
                projected = await WebFetcher.#project(html, projection);
            }
        }
        return projected === null ? null : { body: projected, html };
    }

    static async #project(
        html: { content: string; mimetype: string },
        projection: ProjectionCaps,
    ): Promise<{ content: string; mimetype: string } | null> {
        try {
            return await projection.readable(html.content, html.mimetype);
        } catch (cause) {
            throw new WebMaterializationError("projection", html.mimetype, cause);
        }
    }

    async close(): Promise<void> {
        await this.#browser.close?.();
    }

    async fetch(url: string, opts?: { signal?: AbortSignal }): Promise<WebFetchResult | null> {
        opts?.signal?.throwIfAborted();
        const target = rewriteAcquisitionTarget(url);
        // Bound the byte probe independently. Browser.render owns its navigation
        // deadline so it can apply the substantive-DOM timeout salvage contract.
        const probeTimeout = AbortSignal.timeout(requireNumEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT"));
        const probeSignal = opts?.signal ? AbortSignal.any([opts.signal, probeTimeout]) : probeTimeout;

        let response: Response;
        try {
            response = await Guard.fetch(target, { method: "GET", body: undefined, headers: [["User-Agent", BROWSER_UA]] }, probeSignal);
        } catch (cause) {
            // {§prefetch} AbortSignal.any preserves the first winning reason.
            // Only a caller-owned win escapes; the probe deadline remains the
            // primitive's ordinary dead/liveness result.
            if (opts?.signal?.aborted === true && probeSignal.reason === opts.signal.reason) {
                opts.signal.throwIfAborted();
            }
            // Admission truth belongs to Guard and survives for exact consumers.
            // Search remains free to prune the rejected entry() candidate.
            if (cause instanceof GuardBlockedError || cause instanceof GuardResolutionError) throw cause;
            return null; // generic unreachable and probe timeout are ordinary deadness
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
                    const rendered = await this.#browser.render(target, {
                        workerId: 0,
                        // Caller cancellation still spans the whole operation.
                        // The renderer supplies its own per-navigation deadline.
                        signal: opts?.signal,
                        headers: [["User-Agent", BROWSER_UA]],
                        guard: Guard.admit,
                    });
                    return rendered.html.length > 0 ? { body: rendered.html, mimetype: "text/html" } : null;
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
