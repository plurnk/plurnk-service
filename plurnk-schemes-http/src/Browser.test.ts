// Browser unit tests. Drives the render foundation through an injected fake
// Chromium engine — no real browser, no experimental module-mock flags. The
// fake satisfies the structural ChromiumEngine seam Browser is generic over.

import test from "node:test";
import { strict as assert } from "node:assert";
import Browser, { type ChromiumEngine } from "./Browser.ts";

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
    bodyLen?: number; // evaluate() salvage probe
    onClose?: () => void; // page.close hook (for abort timing)
}

const timeoutError = () => Object.assign(new Error("Timeout 30000ms exceeded"), { name: "TimeoutError" });

const makeEngine = (cfg: FakeConfig = {}) => {
    const calls = { newContext: 0, newPage: 0, pageClose: 0, contextClose: 0, launch: 0, connect: 0 };
    const launchOptions: Array<{ executablePath?: string }> = [];
    const contextOptions: Array<{ isMobile?: boolean; userAgent?: string } | undefined> = [];
    const makePage = () => ({
        async goto() {
            if (cfg.goto) return cfg.goto();
            return response(200, "OK", { "content-type": "text/html; charset=utf-8" });
        },
        async content() { return cfg.html ?? "<html><body>rendered</body></html>"; },
        async evaluate() { return cfg.bodyLen ?? 0; },
        async close() { calls.pageClose++; cfg.onClose?.(); },
    });
    const makeContext = () => ({
        async newPage() { calls.newPage++; return makePage(); },
        async close() { calls.contextClose++; },
    });
    const makeBrowser = () => ({
        async newContext(options?: { isMobile?: boolean; userAgent?: string }) { calls.newContext++; contextOptions.push(options); return makeContext(); },
        on() {},
        async close() {},
    });
    const engine = {
        async launch(options: { executablePath?: string }) { calls.launch++; launchOptions.push(options); return makeBrowser(); },
        async connectOverCDP() { calls.connect++; return makeBrowser(); },
    } as unknown as ChromiumEngine;
    return { engine, calls, contextOptions, launchOptions };
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

test("render: launches locally (no CDP endpoint) and serializes", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/", { workerId: 1 });
    assert.equal(calls.launch, 1);
    assert.equal(calls.connect, 0);
    await browser.close();
});

test("ready: verifies the managed browser before the first render", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    assert.equal(await browser.ready(), "managed");
    assert.equal(calls.launch, 1);
    await browser.close();
});

test("ready: remote mode requires and verifies its CDP endpoint", async () => {
    const previous = process.env.PLURNK_SCHEMES_HTTP_BROWSER;
    const previousEndpoint = process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS;
    process.env.PLURNK_SCHEMES_HTTP_BROWSER = "remote";
    process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS = "http://browser.test:9222";
    try {
        const { engine, calls } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "remote");
        assert.equal(calls.connect, 1);
        assert.equal(calls.launch, 0);
        await browser.close();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SCHEMES_HTTP_BROWSER;
        else process.env.PLURNK_SCHEMES_HTTP_BROWSER = previous;
        if (previousEndpoint === undefined) delete process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS;
        else process.env.PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS = previousEndpoint;
    }
});

test("ready: system mode launches only the configured executable", async () => {
    const previous = process.env.PLURNK_SCHEMES_HTTP_BROWSER;
    const previousPath = process.env.PLURNK_SCHEMES_HTTP_EXECUTABLE_PATH;
    process.env.PLURNK_SCHEMES_HTTP_BROWSER = "system";
    process.env.PLURNK_SCHEMES_HTTP_EXECUTABLE_PATH = "/opt/chromium";
    try {
        const { engine, calls, launchOptions } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "system");
        assert.equal(calls.launch, 1);
        assert.equal(launchOptions[0]?.executablePath, "/opt/chromium");
        await browser.close();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SCHEMES_HTTP_BROWSER;
        else process.env.PLURNK_SCHEMES_HTTP_BROWSER = previous;
        if (previousPath === undefined) delete process.env.PLURNK_SCHEMES_HTTP_EXECUTABLE_PATH;
        else process.env.PLURNK_SCHEMES_HTTP_EXECUTABLE_PATH = previousPath;
    }
});

test("ready: disabled mode performs no browser work and render fails clearly", async () => {
    const previous = process.env.PLURNK_SCHEMES_HTTP_BROWSER;
    process.env.PLURNK_SCHEMES_HTTP_BROWSER = "disabled";
    try {
        const { engine, calls } = makeEngine();
        const browser = new Browser(() => Promise.resolve(engine));
        assert.equal(await browser.ready(), "disabled");
        assert.equal(calls.launch, 0);
        await assert.rejects(browser.render("https://example.com/", { workerId: 1 }), /HTML rendering is disabled/);
        await browser.close();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SCHEMES_HTTP_BROWSER;
        else process.env.PLURNK_SCHEMES_HTTP_BROWSER = previous;
    }
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
    assert.ok(calls.pageClose >= 1, "page was closed on abort");
    await browser.close();
});

test("mobile emulation: contexts default to a mobile profile (schemes-http#4)", async () => {
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
    browser.closeContext(7);
    assert.equal(calls.contextClose, 1);
    await browser.render("https://example.com/c", { workerId: 7 }); // fresh context after drop
    assert.equal(calls.newContext, 2);
    await browser.close();
});
