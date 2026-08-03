// Headless-Chromium render foundation {§render-lifecycle}, derived from
// @possumtech/rummy.web's MIT WebFetcher by the same author. It is a standalone
// package surface whose initialization and shutdown follow {§handler-lifecycle}.
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
interface PwRoute {
    request(): { url(): string };
    continue(): Promise<void>;
    abort(): Promise<void>;
}
interface PwPage {
    route(pattern: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
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
interface PwLaunchOptions {
    headless: boolean;
    chromiumSandbox: boolean;
    timeout: number;
    args: ReadonlyArray<string>;
    channel?: string;
    executablePath?: string;
}
interface PwConnectOptions {
    timeout: number;
}
export interface ChromiumEngine {
    launch(opts: PwLaunchOptions): Promise<PwBrowser>;
    connect(endpoint: string, opts: PwConnectOptions): Promise<PwBrowser>;
    connectOverCDP(endpoint: string, opts: PwConnectOptions): Promise<PwBrowser>;
}
export type ChromiumFactory = () => Promise<ChromiumEngine>;
export type PlaywrightMethod = "launch" | "connect" | "connectOverCDP" | "disabled";

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

// Mobile device emulation (a Pixel-5-class profile) is the configured default;
// PLURNK_SCHEMES_HTTP_MOBILE=0 selects a desktop context {§http-config}.
// The ONE browser identity both acquisition paths present (render context AND
// the byte-path fetch) — ordinary Chrome traffic, never an automated-client or
// plurnk fingerprint. Model-supplied {User-Agent: …} target blocks override it.
export const BROWSER_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const MOBILE_CONTEXT: PwContextOptions = Object.freeze({
    userAgent: BROWSER_UA,
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
});
// Required floor-set knob; unset is a configuration failure {§http-config}.
const mobileEmulation = (): PwContextOptions | undefined => {
    const raw = process.env.PLURNK_SCHEMES_HTTP_MOBILE;
    if (raw === undefined) throw new Error("Browser: required env PLURNK_SCHEMES_HTTP_MOBILE is unset — see .env.defaults");
    return raw === "0" ? undefined : MOBILE_CONTEXT;
};

// Required numeric lookup. `.env.defaults` owns values; call sites own when a
// value becomes necessary, and no in-code fallback hides its absence
// {§http-config}.
export const requireNumEnv = (key: string): number => {
    const raw = process.env[key];
    if (raw === undefined) throw new Error(`Browser: required env ${key} is unset — see .env.defaults`);
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`Browser: ${key}=${raw} is not a number`);
    return n;
};

// Default factory: lazy-import the real chromium. The cast bridges Playwright's
// full type to our structural view at the single trusted library boundary.
const defaultFactory: ChromiumFactory = async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
    return (await import("playwright")).chromium as unknown as ChromiumEngine;
};

const requireBoolEnv = (key: string): boolean => {
    const raw = process.env[key];
    if (raw !== "0" && raw !== "1") throw new Error(`Browser: required env ${key} must be 0 or 1 — see .env.defaults`);
    return raw === "1";
};

type BrowserConfig =
    | { method: "disabled" }
    | { method: "launch"; options: PwLaunchOptions }
    | { method: "connect"; endpoint: string; options: PwConnectOptions }
    | { method: "connectOverCDP"; endpoint: string; options: PwConnectOptions };

const browserConfig = (): BrowserConfig => {
    const raw = process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD;
    if (raw === undefined) throw new Error("Browser: required env PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD is unset — see .env.defaults");
    if (!["launch", "connect", "connectOverCDP", "disabled"].includes(raw)) {
        throw new Error(`Browser: PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD=${raw} must be launch, connect, connectOverCDP, or disabled`);
    }
    const method = raw as PlaywrightMethod;
    const endpoint = process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_ENDPOINT;
    const channel = process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_CHANNEL;
    const executablePath = process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_EXECUTABLE_PATH;
    if ((method === "connect" || method === "connectOverCDP") && !endpoint) {
        throw new Error(`Browser: ${method} requires PLURNK_SCHEMES_HTTP_PLAYWRIGHT_ENDPOINT`);
    }
    if (method !== "connect" && method !== "connectOverCDP" && endpoint) {
        throw new Error(`Browser: PLURNK_SCHEMES_HTTP_PLAYWRIGHT_ENDPOINT is incompatible with ${method}`);
    }
    if (method !== "launch" && (channel || executablePath)) {
        throw new Error(`Browser: Playwright channel and executable path are incompatible with ${method}`);
    }
    if (channel && executablePath) {
        throw new Error("Browser: PLURNK_SCHEMES_HTTP_PLAYWRIGHT_CHANNEL and PLURNK_SCHEMES_HTTP_PLAYWRIGHT_EXECUTABLE_PATH are mutually exclusive");
    }
    if (method === "disabled") return { method };
    const timeout = requireNumEnv("PLURNK_SCHEMES_HTTP_PLAYWRIGHT_TIMEOUT");
    if (method === "connect" || method === "connectOverCDP") {
        return { method, endpoint: endpoint!, options: { timeout } };
    }
    const args: string[] = [];
    const heapMb = process.env.PLURNK_SCHEMES_HTTP_CHROMIUM_HEAP_MB;
    if (heapMb) args.push(`--js-flags=--max-old-space-size=${heapMb}`);
    return {
        method,
        options: {
            headless: requireBoolEnv("PLURNK_SCHEMES_HTTP_PLAYWRIGHT_HEADLESS"),
            chromiumSandbox: requireBoolEnv("PLURNK_SCHEMES_HTTP_PLAYWRIGHT_CHROMIUM_SANDBOX"),
            timeout,
            args,
            ...(channel ? { channel } : {}),
            ...(executablePath ? { executablePath } : {}),
        },
    };
};

export default class Browser {
    #factory: ChromiumFactory;
    #browser: PwBrowser | null = null;
    #launching: Promise<PwBrowser> | null = null;
    // One atomically acquired BrowserContext per worker — cookies / cache /
    // storage scoped to the worker that opened it, no cross-worker bleed.
    // Promises make overlapping first renders share the same acquisition.
    #contexts = new Map<number, Promise<PwContext>>();
    #idleTimer: ReturnType<typeof setTimeout> | null = null;

    // Inject a factory in tests; production lazy-imports playwright.
    constructor(factory: ChromiumFactory = defaultFactory) {
        this.#factory = factory;
    }

    async ready(): Promise<PlaywrightMethod> {
        const { method } = browserConfig();
        if (method !== "disabled") await this.#getBrowser();
        return method;
    }

    // Render a URL to its final serialized DOM. Opens a page in the worker's
    // context, navigates with the settle+salvage strategy, serializes, closes
    // the page. Throws on navigation failure (the caller maps it to a status).
    async render(
        url: string,
        { workerId, signal, headers, guard, timeout = requireNumEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT") }:
            { workerId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]>; guard?: (url: string) => Promise<boolean>; timeout?: number },
    ): Promise<RenderResult> {
        const context = await this.#getContext(workerId);
        const page = await context.newPage();
        // {§http-security-boundary} Every current caller supplies the shared
        // predicate so browser navigation and subresources stay inside the same
        // admission boundary as byte acquisition.
        if (guard) await page.route("**", async (r) => { (await guard(r.request().url())) ? await r.continue() : await r.abort(); });
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

    // Get-or-launch the warm chromium under the one explicitly selected mode.
    // Single browser across all workers;
    // per-worker isolation is at the context layer. Relaunches if chromium dies
    // (OOM/segfault/WS teardown) leaves the handle stale.
    async #getBrowser(): Promise<PwBrowser> {
        this.#touchIdle();
        if (this.#browser) return this.#browser;
        this.#launching ??= (async () => {
            const config = browserConfig();
            if (config.method === "disabled") throw new Error("Browser: HTML rendering is disabled by PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD=disabled");
            const chromium = await this.#factory();
            if (config.method === "connect") return chromium.connect(config.endpoint, config.options);
            if (config.method === "connectOverCDP") return chromium.connectOverCDP(config.endpoint, config.options);
            return chromium.launch(config.options);
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

    // Get-or-create the worker's BrowserContext. Mobile-emulated by default (a
    // lighter responsive layout is the better generation hint); desktop when
    // PLURNK_SCHEMES_HTTP_MOBILE=0.
    async #getContext(workerId: number): Promise<PwContext> {
        this.#touchIdle();
        let context = this.#contexts.get(workerId);
        if (context === undefined) {
            context = (async () => {
                const browser = await this.#getBrowser();
                return browser.newContext(mobileEmulation());
            })();
            this.#contexts.set(workerId, context);
        }
        try {
            return await context;
        } catch (error) {
            if (this.#contexts.get(workerId) === context) this.#contexts.delete(workerId);
            throw error;
        }
    }

    // Drop the worker's context (run end or abort). Closing it cascades to any
    // in-flight page in that context.
    async closeContext(workerId: number): Promise<void> {
        const context = this.#contexts.get(workerId);
        if (!context) return;
        this.#contexts.delete(workerId);
        await (await context).close();
    }

    #touchIdle(): void {
        if (this.#idleTimer) clearTimeout(this.#idleTimer);
        this.#idleTimer = setTimeout(() => {
            void this.close().catch((error: unknown) => {
                console.error("Browser idle cleanup failed", { error });
            });
        }, requireNumEnv("PLURNK_SCHEMES_HTTP_IDLE_TIMEOUT"));
        this.#idleTimer.unref?.();
    }

    // Tear everything down: per-worker contexts then the browser. In CDP mode
    // close() disconnects the local handle without shutting the remote down.
    async close(): Promise<void> {
        if (this.#idleTimer) { clearTimeout(this.#idleTimer); this.#idleTimer = null; }
        const contexts = [...this.#contexts.values()];
        this.#contexts.clear();
        const contextResults = await Promise.allSettled(contexts.map(async (context) => (await context).close()));
        const browser = this.#browser;
        this.#browser = null;
        this.#launching = null;
        const browserResults = browser === null ? [] : await Promise.allSettled([browser.close()]);
        const errors = [...contextResults, ...browserResults]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason]);
        if (errors.length > 0) throw new AggregateError(errors, "Browser shutdown failed");
    }
}
