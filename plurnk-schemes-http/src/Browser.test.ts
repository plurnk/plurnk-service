// Browser unit tests. Drives the render foundation through an injected fake
// Chromium engine — no real browser, no experimental module-mock flags. The
// fake satisfies the structural ChromiumEngine seam Browser is generic over.

import test from "node:test";
import { strict as assert } from "node:assert";
import Browser, { type ChromiumEngine } from "./Browser.ts";
import {
    GuardBlockedError,
    GuardResolutionError,
    type GuardAdmission,
} from "./Guard.ts";

interface PwResponseLike {
    status(): number;
    statusText(): string;
    headers(): Record<string, string>;
}
const response = (status: number, statusText: string, headers: Record<string, string>): PwResponseLike =>
    ({ status: () => status, statusText: () => statusText, headers: () => headers });

interface FakeConfig {
    html?: string;
    goto?: () => Promise<PwResponseLike | null>;
    route?: () => Promise<void>;
    requests?: ReadonlyArray<{
        url: string;
        navigation: boolean;
        mainFrame?: boolean;
        continue?: () => Promise<void>;
        abort?: () => Promise<void>;
    }>;
    bodyLen?: number; // evaluate() salvage probe
    onClose?: () => void; // page.close hook (for abort timing)
    pageClose?: () => Promise<void>;
    contextClose?: (contextNumber: number) => Promise<void>;
    browserClose?: () => Promise<void>;
}

const timeoutError = () => Object.assign(new Error("Timeout 30000ms exceeded"), { name: "TimeoutError" });

const makeEngine = (cfg: FakeConfig = {}) => {
    const calls = { newContext: 0, newPage: 0, goto: 0, routeContinue: 0, routeAbort: 0, pageClose: 0, contextClose: 0, browserClose: 0, launch: 0, connect: 0, connectOverCDP: 0 };
    const launchOptions: Array<{ channel?: string; executablePath?: string; headless?: boolean; chromiumSandbox?: boolean; timeout?: number }> = [];
    const endpoints: string[] = [];
    const contextOptions: Array<{ isMobile?: boolean; userAgent?: string } | undefined> = [];
    const makePage = () => {
        const mainFrame = {};
        let routeHandler: ((route: {
            request(): { url(): string; isNavigationRequest(): boolean; frame(): object };
            continue(): Promise<void>;
            abort(): Promise<void>;
        }) => Promise<void>) | undefined;
        return {
            mainFrame: () => mainFrame,
            async route(_pattern: string, handler: typeof routeHandler) {
                await cfg.route?.();
                routeHandler = handler;
            },
            async setExtraHTTPHeaders() {},
            async goto() {
                calls.goto++;
                let navigationAborted = false;
                for (const request of cfg.requests ?? []) {
                    await routeHandler?.({
                        request: () => ({
                            url: () => request.url,
                            isNavigationRequest: () => request.navigation,
                            frame: () => request.mainFrame === false ? {} : mainFrame,
                        }),
                        continue: async () => {
                            calls.routeContinue++;
                            await request.continue?.();
                        },
                        abort: async () => {
                            calls.routeAbort++;
                            if (request.navigation && request.mainFrame !== false) navigationAborted = true;
                            await request.abort?.();
                        },
                    });
                }
                if (navigationAborted) throw new Error("net::ERR_FAILED");
                if (cfg.goto) return cfg.goto();
                return response(200, "OK", { "content-type": "text/html; charset=utf-8" });
            },
            async content() { return cfg.html ?? "<html><body>rendered</body></html>"; },
            async evaluate() { return cfg.bodyLen ?? 0; },
            async close() { calls.pageClose++; cfg.onClose?.(); await cfg.pageClose?.(); },
        };
    };
    const makeContext = (contextNumber: number) => ({
        async newPage() { calls.newPage++; return makePage(); },
        async close() { calls.contextClose++; await cfg.contextClose?.(contextNumber); },
    });
    const makeBrowser = () => ({
        async newContext(options?: { isMobile?: boolean; userAgent?: string }) { calls.newContext++; contextOptions.push(options); return makeContext(calls.newContext); },
        on() {},
        async close() { calls.browserClose++; await cfg.browserClose?.(); },
    });
    const engine = {
        async launch(options: { channel?: string; executablePath?: string }) { calls.launch++; launchOptions.push(options); return makeBrowser(); },
        async connect(endpoint: string) { calls.connect++; endpoints.push(endpoint); return makeBrowser(); },
        async connectOverCDP(endpoint: string) { calls.connectOverCDP++; endpoints.push(endpoint); return makeBrowser(); },
    } as unknown as ChromiumEngine;
    return { engine, calls, contextOptions, launchOptions, endpoints };
};

const withEnv = async (values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> => {
    const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        await fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

test("render: returns status, headers, and the serialized DOM", async () => {
    const { engine } = makeEngine({ html: "<html><body>hi</body></html>" });
    const browser = new Browser(() => Promise.resolve(engine));
    const r = await browser.render("https://example.com/", { workerId: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.statusText, "OK");
    assert.equal(r.html, "<html><body>hi</body></html>");
    assert.deepEqual(r.headers, [["content-type", "text/html; charset=utf-8"]]);
    await browser.close();
});

test("render: launches the bundled browser by default and serializes", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/", { workerId: 1 });
    assert.equal(calls.launch, 1);
    assert.equal(calls.connect, 0);
    assert.equal(calls.connectOverCDP, 0);
    await browser.close();
});

test("ready: verifies launch before the first render and maps Playwright options", async () => {
    const { engine, calls, launchOptions } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    assert.equal(await browser.ready(), "launch");
    assert.equal(calls.launch, 1);
    assert.deepEqual(launchOptions[0], {
        headless: true,
        chromiumSandbox: false,
        timeout: 30000,
        args: [],
    });
    await browser.close();
});

test("ready: connect uses a Playwright protocol endpoint", async () => {
    await withEnv({
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "connect",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_ENDPOINT: "ws://browser.test/playwright",
    }, async () => {
        const { engine, calls, endpoints } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "connect");
        assert.equal(calls.connect, 1);
        assert.equal(calls.connectOverCDP, 0);
        assert.equal(calls.launch, 0);
        assert.deepEqual(endpoints, ["ws://browser.test/playwright"]);
        await browser.close();
    });
});

test("ready: connectOverCDP attaches to a running Chromium browser", async () => {
    await withEnv({
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "connectOverCDP",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_ENDPOINT: "http://browser.test:9222",
    }, async () => {
        const { engine, calls, endpoints } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "connectOverCDP");
        assert.equal(calls.connect, 0);
        assert.equal(calls.connectOverCDP, 1);
        assert.equal(calls.launch, 0);
        assert.deepEqual(endpoints, ["http://browser.test:9222"]);
        await browser.close();
    });
});

test("ready: launch supports a regular browser channel", async () => {
    await withEnv({ PLURNK_SCHEMES_HTTP_PLAYWRIGHT_CHANNEL: "chrome" }, async () => {
        const { engine, launchOptions } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "launch");
        assert.equal(launchOptions[0]?.channel, "chrome");
        await browser.close();
    });
});

test("ready: launch supports an exact executable path", async () => {
    await withEnv({ PLURNK_SCHEMES_HTTP_PLAYWRIGHT_EXECUTABLE_PATH: "/opt/chromium" }, async () => {
        const { engine, calls, launchOptions } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "launch");
        assert.equal(calls.launch, 1);
        assert.equal(launchOptions[0]?.executablePath, "/opt/chromium");
        await browser.close();
    });
});

test("ready: disabled performs no browser work and render fails clearly", async () => {
    await withEnv({
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_TIMEOUT: undefined,
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_HEADLESS: undefined,
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_CHROMIUM_SANDBOX: undefined,
    }, async () => {
        const { engine, calls } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "disabled");
        assert.equal(calls.launch, 0);
        await assert.rejects(browser.render("https://example.com/", { workerId: 1 }), /HTML rendering is disabled/);
        await browser.close();
    });
});

test("configuration rejects incompatible Playwright selections", async () => {
    await withEnv({
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "launch",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_CHANNEL: "chrome",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_EXECUTABLE_PATH: "/opt/chromium",
    }, async () => {
        const { engine } = makeEngine();
        await assert.rejects(new Browser(() => Promise.resolve(engine)).ready(), /mutually exclusive/);
    });
});

test("salvage: networkidle timeout with substantive body text → returns html, status 200", async () => {
    const { engine } = makeEngine({ goto: async () => { throw timeoutError(); }, bodyLen: 500, html: "<html><body>chatty</body></html>" });
    const browser = new Browser(() => Promise.resolve(engine));
    const r = await browser.render("https://example.com/", { workerId: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.html, "<html><body>chatty</body></html>");
    assert.deepEqual(r.headers, []); // salvage path has no Response
    await browser.close();
});

test("salvage: timeout below the body-text threshold → throws (skeleton, not a page)", async () => {
    const { engine } = makeEngine({ goto: async () => { throw timeoutError(); }, bodyLen: 10 });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(browser.render("https://example.com/", { workerId: 1 }), /Timeout/);
    await browser.close();
});

test("non-timeout navigation error re-throws (not salvaged)", async () => {
    const { engine } = makeEngine({ goto: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(browser.render("https://nope.invalid/", { workerId: 1 }), /ERR_NAME_NOT_RESOLVED/);
    await browser.close();
});

test("route admission: a refused main navigation surfaces the typed policy error", async () => {
    const target = "https://private.example/";
    const failure = new GuardBlockedError(target);
    const { engine, calls } = makeEngine({
        requests: [{ url: target, navigation: true }],
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        browser.render(target, {
            workerId: 1,
            guard: async () => ({ admitted: false, error: failure }),
        }),
        (error: unknown) => error === failure,
    );
    assert.equal(calls.routeContinue, 0);
    assert.equal(calls.routeAbort, 1);
    await browser.close();
});

test("route admission: a DNS-failed main navigation surfaces the typed resolution error", async () => {
    const target = "https://missing.example/";
    const failure = new GuardResolutionError(target, new Error("resolver unavailable"));
    const { engine } = makeEngine({
        requests: [{ url: target, navigation: true }],
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        browser.render(target, {
            workerId: 1,
            guard: async () => ({ admitted: false, error: failure }),
        }),
        (error: unknown) => error === failure,
    );
    await browser.close();
});

test("route admission: refused subresources and child frames do not discard an admitted page", async () => {
    const target = "https://example.com/";
    const asset = "http://127.0.0.1/tracker";
    const childFrame = "http://127.0.0.1/embed";
    const failure = new GuardBlockedError(asset);
    const { engine, calls } = makeEngine({
        requests: [
            { url: target, navigation: true },
            { url: asset, navigation: false },
            { url: childFrame, navigation: true, mainFrame: false },
        ],
    });
    const browser = new Browser(() => Promise.resolve(engine));
    const guard = async (url: string): Promise<GuardAdmission> => url === asset || url === childFrame
        ? { admitted: false, error: failure }
        : { admitted: true };
    const rendered = await browser.render(target, { workerId: 1, guard });
    assert.match(rendered.html, /rendered/);
    assert.equal(calls.routeContinue, 1);
    assert.equal(calls.routeAbort, 2);
    await browser.close();
});

test("route admission: an unexpected guard failure is owned by render, not an unhandled callback", async () => {
    const cause = new Error("guard implementation failed");
    const target = "https://example.com/";
    const { engine, calls } = makeEngine({
        requests: [{ url: target, navigation: true }],
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        browser.render(target, {
            workerId: 1,
            guard: async () => { throw cause; },
        }),
        (error: unknown) => error === cause,
    );
    assert.equal(calls.routeAbort, 1);
    await browser.close();
});

test("route admission: a route-action failure is owned by render", async () => {
    const cause = new Error("route continue failed");
    const target = "https://example.com/";
    const { engine, calls } = makeEngine({
        requests: [{
            url: target,
            navigation: true,
            continue: async () => { throw cause; },
        }],
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        browser.render(target, {
            workerId: 1,
            guard: async () => ({ admitted: true }),
        }),
        (error: unknown) => error === cause,
    );
    assert.equal(calls.routeContinue, 1);
    assert.equal(calls.routeAbort, 1);
    await browser.close();
});

// {§render-lifecycle}
test("#125: a page-close failure becomes the render failure", async () => {
    const { engine, calls } = makeEngine({
        pageClose: async () => { throw new Error("page close failed"); },
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        () => browser.render("https://example.com/", { workerId: 1 }),
        /page close failed/,
    );
    assert.equal(calls.pageClose, 1);
    await browser.close();
});

// {§render-lifecycle}
test("#125: abort-driven navigation and page-close failures retain both causes", async () => {
    const controller = new AbortController();
    const { engine, calls } = makeEngine({
        goto: async () => {
            controller.abort();
            throw new Error("Target closed");
        },
        pageClose: async () => { throw new Error("page close failed"); },
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        () => browser.render("https://example.com/", { workerId: 1, signal: controller.signal }),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors.map((cause) => String(cause)), [
                "Error: Target closed",
                "Error: page close failed",
            ]);
            return true;
        },
    );
    assert.equal(calls.pageClose, 1);
    await browser.close();
});

// {§render-lifecycle}
test("#125: setup failure still closes the opened page before navigation", async () => {
    const { engine, calls } = makeEngine({
        route: async () => { throw new Error("route setup failed"); },
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        () => browser.render("https://example.com/", {
            workerId: 1,
            guard: async () => ({ admitted: true }),
        }),
        /route setup failed/,
    );
    assert.equal(calls.goto, 0);
    assert.equal(calls.pageClose, 1);
    await browser.close();
});

// {§render-lifecycle}
test("#125: an already-aborted render closes once and never navigates", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(
        () => browser.render("https://example.com/", {
            workerId: 1,
            signal: AbortSignal.abort(new Error("render cancelled")),
        }),
        /render cancelled/,
    );
    assert.equal(calls.goto, 0);
    assert.equal(calls.pageClose, 1);
    await browser.close();
});

test("abort: aborting the signal closes the page, unblocking an in-flight navigation", async () => {
    let tripClose: () => void = () => {};
    const closed = new Promise<void>((r) => { tripClose = r; });
    const controller = new AbortController();
    // goto trips the abort (the listener is attached by now) then hangs until
    // the page is closed, rejecting like Playwright's "Target closed" — exactly
    // the abort cascade, with no attach-vs-abort race.
    const { engine, calls } = makeEngine({
        goto: () => { controller.abort(); return closed.then(() => { throw new Error("Target closed"); }); },
        onClose: () => tripClose(),
    });
    const browser = new Browser(() => Promise.resolve(engine));
    const p = browser.render("https://example.com/", { workerId: 1, signal: controller.signal });
    await assert.rejects(p, /Target closed/);
    assert.equal(calls.pageClose, 1, "abort and final settlement share one page close");
    await browser.close();
});

test("mobile emulation: contexts default to the configured mobile profile", async () => {
    const { engine, contextOptions } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/", { workerId: 1 });
    assert.equal(contextOptions[0]?.isMobile, true);
    assert.match(contextOptions[0]?.userAgent ?? "", /Mobile/);
    await browser.close();
});

test("mobile emulation: PLURNK_SCHEMES_HTTP_MOBILE=0 renders desktop (no emulation)", async () => {
    const prev = process.env.PLURNK_SCHEMES_HTTP_MOBILE;
    process.env.PLURNK_SCHEMES_HTTP_MOBILE = "0";
    try {
        const { engine, contextOptions } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        await browser.render("https://example.com/", { workerId: 1 });
        assert.equal(contextOptions[0], undefined);
        await browser.close();
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SCHEMES_HTTP_MOBILE;
        else process.env.PLURNK_SCHEMES_HTTP_MOBILE = prev;
    }
});

test("mobile emulation: unset MOBILE crashes naming the var (floor-set knob, no silent default)", async () => {
    const prev = process.env.PLURNK_SCHEMES_HTTP_MOBILE;
    delete process.env.PLURNK_SCHEMES_HTTP_MOBILE;
    try {
        const { engine } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        await assert.rejects(browser.render("https://example.com/", { workerId: 1 }), /PLURNK_SCHEMES_HTTP_MOBILE is unset/);
        await browser.close();
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SCHEMES_HTTP_MOBILE;
        else process.env.PLURNK_SCHEMES_HTTP_MOBILE = prev;
    }
});

test("per-worker context: reused across renders, dropped by closeContext", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/a", { workerId: 7 });
    await browser.render("https://example.com/b", { workerId: 7 });
    assert.equal(calls.newContext, 1); // one context for the worker, two pages
    assert.equal(calls.newPage, 2);
    await browser.closeContext(7);
    assert.equal(calls.contextClose, 1);
    await browser.render("https://example.com/c", { workerId: 7 }); // fresh context after drop
    assert.equal(calls.newContext, 2);
    await browser.close();
});

test("per-worker context: overlapping renders share one atomic context acquisition", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));

    await Promise.all([
        browser.render("https://example.com/a", { workerId: 7 }),
        browser.render("https://example.com/b", { workerId: 7 }),
    ]);

    assert.equal(calls.newContext, 1, "overlapping calls cannot overwrite and leak a second worker context");
    assert.equal(calls.newPage, 2);
    await browser.close();
});

test("close attempts every context and browser close, then aggregates every failure", async () => {
    const { engine, calls } = makeEngine({
        contextClose: async (contextNumber) => { throw new Error(`context ${contextNumber} close failed`); },
        browserClose: async () => { throw new Error("browser close failed"); },
    });
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/a", { workerId: 1 });
    await browser.render("https://example.com/b", { workerId: 2 });

    await assert.rejects(
        () => browser.close(),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors.map((cause) => String(cause)), [
                "Error: context 1 close failed",
                "Error: context 2 close failed",
                "Error: browser close failed",
            ]);
            return true;
        },
    );
    assert.equal(calls.contextClose, 2);
    assert.equal(calls.browserClose, 1);
});
