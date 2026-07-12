// Browser — the headless-Chromium render foundation (SPEC §render-lifecycle),
// ported from rummy.web's WebFetcher (@possumtech/rummy.web, MIT, same author). A
// STANDALONE foundation, not Http-private: the render scheme drives it now,
// and a future plurnk browser-troubleshooting MCP sits on the same warm pool.
//
// Scope here is render-ONLY: navigate, let JS run + hydration settle, serialize
// the final DOM. It returns the true rendered page; it never cleans, strips,
// or extracts — projection (markdown/symbols/deepXml) is the mimetype layer's
// job, off the faithful body we hand over.
//
// Driver is Playwright, lazy-imported so only the render path pays for it (the
// raw-byte fetch path stays Node-builtin-only). The engine is reached through
// a minimal structural seam (`ChromiumEngine`) so it can be injected — fakes
// in unit tests, and a remote CDP endpoint (Lightpanda/browserless/shared
// chromium) swapped in via env with zero code change.

// ── the structural Playwright surface we drive ────────────────────────────
// Only the handful of methods we use, so the seam is injectable and the heavy
// playwright types stay off everything but the default factory.
interface PwResponse {
    status(): number;
    statusText(): string;
    headers(): Record<string, string>;
}
interface PwPage {
    goto(url: string, opts: { waitUntil: "networkidle"; timeout: number }): Promise<PwResponse | null>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
    content(): Promise<string>;
    evaluate<T>(fn: () => T): Promise<T>;
    close(): Promise<void>;
}
interface PwContext {
    newPage(): Promise<PwPage>;
    close(): Promise<void>;
}
// The subset of Playwright's newContext options we set for device emulation.
interface PwContextOptions {
    userAgent: string;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
}
interface PwBrowser {
    newContext(options?: PwContextOptions): Promise<PwContext>;
    on(event: "disconnected", cb: () => void): void;
    close(): Promise<void>;
}
export interface ChromiumEngine {
    launch(opts: { headless: boolean; args: ReadonlyArray<string> }): Promise<PwBrowser>;
    connect(wsEndpoint: string): Promise<PwBrowser>;
}
export type ChromiumFactory = () => Promise<ChromiumEngine>;

// `document` exists only inside page.evaluate (the browser context, where the
// callback is serialized and run). Declared narrowly so the salvage probe
// type-checks without pulling the DOM lib into this Node package.
declare const document: { readonly body: { readonly innerText: string } | null } | undefined;

export interface RenderResult {
    readonly status: number;
    readonly statusText: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly html: string;
}

// Mobile device emulation (a Pixel-5-class profile). Responsive sites serve a
// lighter, less-chrome layout to a mobile viewport/UA — a general generation
// hint, not a per-host rewrite (schemes-http#4). Default ON; set
// PLURNK_SCHEMES_HTTP_MOBILE=0 to render as desktop (escape hatch for the tail
// of sites that serve degraded/blocked mobile content). NOTE: Wikipedia gates
// mobile on the domain, not the UA, so this is a no-op there — by design; its
// desktop page already extracts clean.
const MOBILE_CONTEXT: PwContextOptions = Object.freeze({
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
});
const mobileEmulation = (): PwContextOptions | undefined =>
    process.env.PLURNK_SCHEMES_HTTP_MOBILE === "0" ? undefined : MOBILE_CONTEXT;

// Required numeric knob — `.env.defaults` is the canonical list (schemes#31:
// the file IS the docs and the daemon floor-sets it at boot; no in-code
// default hides a magic number). An
// unset or non-numeric value fails hard at first use, naming the var. All
// three numerics are render-path-only, so a byte-fetch-only deployment never
// pays them — but a rendering one must configure them.
const requireNumEnv = (key: string): number => {
    const raw = process.env[key];
    if (raw === undefined) throw new Error(`Browser: required env ${key} is unset — see .env.defaults`);
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`Browser: ${key}=${raw} is not a number`);
    return n;
};

// Default factory: lazy-import the real chromium. The cast bridges Playwright's
// full type to our structural view at the single trusted library boundary.
const defaultFactory: ChromiumFactory = async () =>
    (await import("playwright")).chromium as unknown as ChromiumEngine;

export default class Browser {
    #factory: ChromiumFactory;
    #browser: PwBrowser | null = null;
    #launching: Promise<PwBrowser> | null = null;
    // One BrowserContext per run — cookies / cache / storage scoped to the run
    // that opened it, no cross-run bleed. Closed by closeContext() on run end
    // or abort. The browser process stays warm across all of them.
    #contexts = new Map<number, PwContext>();
    #idleTimer: ReturnType<typeof setTimeout> | null = null;

    // Inject a factory in tests; production lazy-imports playwright.
    constructor(factory: ChromiumFactory = defaultFactory) {
        this.#factory = factory;
    }

    // Render a URL to its final serialized DOM. Opens a page in the run's
    // context, navigates with the settle+salvage strategy, serializes, closes
    // the page. Throws on navigation failure (the caller maps it to a status).
    async render(
        url: string,
        { runId, signal, headers, timeout = requireNumEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT") }:
            { runId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]>; timeout?: number },
    ): Promise<RenderResult> {
        const context = await this.#getContext(runId);
        const page = await context.newPage();
        // Request headers (auth/accept) apply to the navigation too, so an authed
        // HTML page renders authenticated. Ordered pairs collapse to a record here
        // — Playwright's per-page header API is single-valued (dup names not a
        // render concern; the byte-path fetch preserves them).
        if (headers && headers.length > 0) await page.setExtraHTTPHeaders(Object.fromEntries(headers));
        // Abort cascades by closing the page — an in-flight goto rejects with
        // "Target closed", surfacing promptly instead of blocking on timeout.
        const onAbort = () => { page.close().catch(() => {}); };
        signal?.addEventListener("abort", onAbort, { once: true });
        // Already aborted before the page opened: the listener won't fire
        // retroactively, so close now — the navigation must not proceed.
        if (signal?.aborted) onAbort();
        try {
            const response = await this.#safeGoto(page, url, timeout);
            const html = await page.content();
            return {
                status: response?.status() ?? 200,
                statusText: response?.statusText() ?? "",
                headers: response ? Object.entries(response.headers()) : [],
                html,
            };
        } finally {
            signal?.removeEventListener("abort", onAbort);
            await page.close().catch(() => {});
        }
    }

    // page.goto with the salvage path. networkidle timing out while the DOM has
    // already rendered substantive body text is the chatty-page case: the
    // content is there even though the network never settled. readyState is
    // unreliable (a never-ending stream stays `loading` forever); the load-
    // bearing signal is the body's innerText length — below the salvage
    // threshold we discard (too little to be sure the DOM rendered the article
    // rather than a skeleton). Returns the Response on normal completion, null
    // on salvage, and re-throws every other error.
    async #safeGoto(page: PwPage, url: string, timeout: number): Promise<PwResponse | null> {
        try {
            return await page.goto(url, { waitUntil: "networkidle", timeout });
        } catch (err) {
            if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
            const bodyLen = await page
                .evaluate(() => document?.body?.innerText?.length ?? 0)
                .catch(() => 0);
            if (bodyLen < requireNumEnv("PLURNK_SCHEMES_HTTP_SALVAGE_MIN_BODY_CHARS")) throw err;
            return null;
        }
    }

    // Get-or-launch the warm chromium. Connects to a remote CDP endpoint via
    // PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS if set (shared / Lightpanda /
    // browserless), else launches locally. Single browser across all runs;
    // per-run isolation is at the context layer. Relaunches if chromium dies
    // (OOM/segfault/WS teardown) leaves the handle stale.
    async #getBrowser(): Promise<PwBrowser> {
        this.#touchIdle();
        if (this.#browser) return this.#browser;
        this.#launching ??= (async () => {
            const chromium = await this.#factory();
            const ws = process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS;
            if (ws) return chromium.connect(ws);
            const args: string[] = [];
            if (process.env.PLURNK_SCHEMES_HTTP_NO_SANDBOX === "1") args.push("--no-sandbox");
            const heapMb = process.env.PLURNK_SCHEMES_HTTP_CHROMIUM_HEAP_MB;
            if (heapMb) args.push(`--js-flags=--max-old-space-size=${heapMb}`);
            return chromium.launch({ headless: true, args });
        })();
        const browser = await this.#launching;
        this.#launching = null;
        browser.on("disconnected", () => {
            if (this.#browser === browser) {
                this.#browser = null;
                this.#contexts.clear();
            }
        });
        this.#browser = browser;
        return browser;
    }

    // Get-or-create the run's BrowserContext. Mobile-emulated by default (a
    // lighter responsive layout is the better generation hint); desktop when
    // PLURNK_SCHEMES_HTTP_MOBILE=0.
    async #getContext(runId: number): Promise<PwContext> {
        this.#touchIdle();
        const existing = this.#contexts.get(runId);
        if (existing) return existing;
        const browser = await this.#getBrowser();
        const context = await browser.newContext(mobileEmulation());
        this.#contexts.set(runId, context);
        return context;
    }

    // Drop the run's context (run end or abort). Closing it cascades to any
    // in-flight page in that context. Fire-and-forget.
    closeContext(runId: number): void {
        const context = this.#contexts.get(runId);
        if (!context) return;
        this.#contexts.delete(runId);
        context.close().catch(() => {});
    }

    #touchIdle(): void {
        if (this.#idleTimer) clearTimeout(this.#idleTimer);
        this.#idleTimer = setTimeout(() => { this.close().catch(() => {}); }, requireNumEnv("PLURNK_SCHEMES_HTTP_IDLE_TIMEOUT"));
        this.#idleTimer.unref?.();
    }

    // Tear everything down: per-run contexts then the browser. In CDP mode
    // close() disconnects the local handle without shutting the remote down.
    async close(): Promise<void> {
        if (this.#idleTimer) { clearTimeout(this.#idleTimer); this.#idleTimer = null; }
        const contexts = [...this.#contexts.values()];
        this.#contexts.clear();
        await Promise.allSettled(contexts.map((c) => c.close()));
        if (this.#browser) { await this.#browser.close().catch(() => {}); this.#browser = null; }
        this.#launching = null;
    }
}
