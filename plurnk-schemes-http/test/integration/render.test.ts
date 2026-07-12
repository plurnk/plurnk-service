// Real-browser integration tests — launch actual headless Chromium (no mock)
// and prove the thing the unit mocks can't: that Playwright runs the page's JS
// and we serialize the FINAL, post-hydration DOM, not the as-served shim. Kept
// out of the unit suite (src/**) so units stay fast/deterministic; run via
// `npm run test:integration`. Needs a chromium binary (npx playwright install
// chromium, or the shared ms-playwright cache).

import test from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
    SchemeCtx, SubscriptionHandle, ReadStatement, UrlPath,
} from "@plurnk/plurnk-schemes";
import Browser from "../../src/Browser.ts";
import Http from "../../src/Http.ts";

// A page whose REAL content exists only after JS runs: the as-served body says
// SHIM, a script rewrites it to RENDERED_BY_JS. A faithful render shows the
// latter and never the former.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>`
    + `<div id="root">SHIM</div>`
    + `<script>document.getElementById("root").textContent = "RENDERED_BY_JS";</script>`
    + `</body></html>`;

const startServer = (): Promise<http.Server> =>
    new Promise((resolve) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(PAGE);
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });

const urlOf = (server: http.Server): string =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

test("Browser.render: real chromium runs the page JS and serializes the final DOM", async () => {
    const server = await startServer();
    const browser = new Browser();
    try {
        const r = await browser.render(urlOf(server), { runId: 1 });
        assert.equal(r.status, 200);
        assert.match(r.html, /RENDERED_BY_JS/);   // JS executed
        assert.doesNotMatch(r.html, /SHIM/);        // post-hydration DOM, not the as-served body
    } finally {
        await browser.close();
        server.close();
    }
});

// Minimal conformant ctx recording the streamed chunks.
const makeCtx = () => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let closed: { reason: string; outcome?: string } | null = null;
    const ok = async () => ({ status: 200 });
    const ctx: SchemeCtx = {
        sessionId: 1, runId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries: { read: async () => ({ status: 404, entry: null }), write: async () => ({ status: 201, created: true, entryId: 1 }), delete: ok },
        channels: { append: ok, replace: ok, setState: ok },
        tags: { add: ok, remove: ok, list: async () => ({ status: 200, tags: [] }) },
        notify: { streamEvent() {} },
        subscriptions: {
            async open(_p: string, _h: SubscriptionHandle) { return new AbortController().signal; },
            async notifyChunk(channel, chunk, mimetype) { chunks.push({ channel, chunk, mimetype }); },
            async close(reason, outcome) { closed = { reason, outcome }; },
        },
        crossScheme: { _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape" },
    };
    return { ctx, inspect: () => ({ chunks, closed }) };
};

const readStmt = (raw: string): ReadStatement => ({
    op: "READ", suffix: "READ", signal: null, body: null, lineMarker: null,
    position: { line: 0, column: 0 },
    target: { kind: "url", raw, scheme: "http", username: null, password: null, hostname: "127.0.0.1", port: null, pathname: "/", params: {}, fragment: null } as UrlPath,
});

test("Http.read: full render path against real chromium — body is the rendered DOM, labelled text/html", async () => {
    const server = await startServer();
    const browser = new Browser();          // injected so the test owns teardown
    const { ctx, inspect } = makeCtx();
    try {
        const r = await new Http(browser).read(readStmt(urlOf(server)), ctx);
        assert.equal(r.status, 102);
        const body = inspect().chunks.filter((c) => c.channel === "body");
        assert.equal(body.length, 1);                    // single-shot rendered DOM
        assert.match(body[0].chunk, /RENDERED_BY_JS/);   // real render, real JS
        assert.doesNotMatch(body[0].chunk, /SHIM/);
        assert.equal(body[0].mimetype, "text/html");     // labelled for the mime layer
        assert.equal(inspect().closed?.reason, "done");
    } finally {
        await browser.close();
        server.close();
    }
});
