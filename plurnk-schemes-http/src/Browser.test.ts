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
        async launch() { calls.launch++; return makeBrowser(); },
        async connect() { calls.connect++; return makeBrowser(); },
    } as unknown as ChromiumEngine;
    return { engine, calls, contextOptions };
};

test("render: returns status, headers, and the serialized DOM", async () => {
    const { engine } = makeEngine({ html: "<html><body>hi</body></html>" });
    const browser = new Browser(() => Promise.resolve(engine));
    const r = await browser.render("https://example.com/", { runId: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.statusText, "OK");
    assert.equal(r.html, "<html><body>hi</body></html>");
    assert.deepEqual(r.headers, [["content-type", "text/html; charset=utf-8"]]);
    await browser.close();
});

test("render: launches locally (no CDP endpoint) and serializes", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/", { runId: 1 });
    assert.equal(calls.launch, 1);
    assert.equal(calls.connect, 0);
    await browser.close();
});

test("salvage: networkidle timeout with substantive body text → returns html, status 200", async () => {
    const { engine } = makeEngine({ goto: async () => { throw timeoutError(); }, bodyLen: 500, html: "<html><body>chatty</body></html>" });
    const browser = new Browser(() => Promise.resolve(engine));
    const r = await browser.render("https://example.com/", { runId: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.html, "<html><body>chatty</body></html>");
    assert.deepEqual(r.headers, []); // salvage path has no Response
    await browser.close();
});

test("salvage: timeout below the body-text threshold → throws (skeleton, not a page)", async () => {
    const { engine } = makeEngine({ goto: async () => { throw timeoutError(); }, bodyLen: 10 });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(browser.render("https://example.com/", { runId: 1 }), /Timeout/);
    await browser.close();
});

test("non-timeout navigation error re-throws (not salvaged)", async () => {
    const { engine } = makeEngine({ goto: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } });
    const browser = new Browser(() => Promise.resolve(engine));
    await assert.rejects(browser.render("https://nope.invalid/", { runId: 1 }), /ERR_NAME_NOT_RESOLVED/);
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
    const p = browser.render("https://example.com/", { runId: 1, signal: controller.signal });
    await assert.rejects(p, /Target closed/);
    assert.ok(calls.pageClose >= 1, "page was closed on abort");
    await browser.close();
});

test("mobile emulation: contexts default to a mobile profile (schemes-http#4)", async () => {
    const { engine, contextOptions } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/", { runId: 1 });
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
        await browser.render("https://example.com/", { runId: 1 });
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
        await assert.rejects(browser.render("https://example.com/", { runId: 1 }), /PLURNK_SCHEMES_HTTP_MOBILE is unset/);
        await browser.close();
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SCHEMES_HTTP_MOBILE;
        else process.env.PLURNK_SCHEMES_HTTP_MOBILE = prev;
    }
});

test("per-run context: reused across renders, dropped by closeContext", async () => {
    const { engine, calls } = makeEngine();
    const browser = new Browser(() => Promise.resolve(engine));
    await browser.render("https://example.com/a", { runId: 7 });
    await browser.render("https://example.com/b", { runId: 7 });
    assert.equal(calls.newContext, 1); // one context for the run, two pages
    assert.equal(calls.newPage, 2);
    browser.closeContext(7);
    assert.equal(calls.contextClose, 1);
    await browser.render("https://example.com/c", { runId: 7 }); // fresh context after drop
    assert.equal(calls.newContext, 2);
    await browser.close();
});
