// Real-browser integration tests — launch actual headless Chromium (no mock)
// and prove the thing the unit mocks can't: that Playwright runs the page's JS
// and we serialize the FINAL, post-hydration DOM, not the as-served shim. Kept
// out of the unit suite (src/**) so units stay fast/deterministic; run via
// `npm run test:intg`. Needs a chromium binary (npx playwright install
// chromium, or the shared ms-playwright cache).

import test from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
    SchemeCtx, SchemeResult, SubscriptionHandle, ReadStatement, UrlPath,
} from "@plurnk/plurnk-schemes";
import Browser from "../../src/Browser.ts";
import Guard, { GuardBlockedError, type GuardAdmission } from "../../src/Guard.ts";
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

const admitAll = async (): Promise<GuardAdmission> => ({ admitted: true });

test("Browser.render: real chromium runs the page JS and serializes the final DOM", async () => {
    const server = await startServer();
    const browser = new Browser();
    try {
        const r = await browser.render(urlOf(server), { workerId: 1, guard: admitAll });
        assert.equal(r.status, 200);
        assert.match(r.html, /RENDERED_BY_JS/);   // JS executed
        assert.doesNotMatch(r.html, /SHIM/);        // post-hydration DOM, not the as-served body
    } finally {
        await browser.close();
        server.close();
    }
});

test("Browser.render: browser-created network surfaces cannot bypass admission", async () => {
    const reached = { popup: 0, serviceWorker: 0, webSocket: 0 };
    const server = http.createServer((req, res) => {
        if (req.url === "/popup") reached.popup += 1;
        if (req.url === "/sw.js") reached.serviceWorker += 1;
        res.writeHead(200, { "content-type": req.url === "/sw.js" ? "text/javascript" : "text/html" });
        const body = req.url === "/"
            ? `<!doctype html><body><script>
                window.open("/popup", "plurnk-popup");
                navigator.serviceWorker.register("/sw.js").catch(() => {});
                const socket = new WebSocket("ws://" + location.host + "/socket");
                socket.onerror = () => {};
                const blank = window.open("about:blank", "plurnk-blank");
                if (blank) {
                    const blankSocket = new blank.WebSocket("ws://" + location.host + "/blank-socket");
                    blankSocket.onerror = () => {};
                }
            </script></body>`
            : req.url === "/socket-page"
                ? `<!doctype html><body><script>
                    const socket = new WebSocket("ws://" + location.host + "/socket");
                    socket.onerror = () => {};
                </script></body>`
                : "ok";
        res.end(body);
    });
    server.on("upgrade", (_req, socket) => {
        reached.webSocket += 1;
        socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = new Browser();
    const root = urlOf(server);
    const guard = async (raw: string): Promise<GuardAdmission> => new URL(raw).pathname === "/"
        ? { admitted: true }
        : { admitted: false, error: new GuardBlockedError(raw) };
    try {
        await browser.render(root, { workerId: 1, guard });
        assert.deepEqual(reached, { popup: 0, serviceWorker: 0, webSocket: 0 });
        await browser.render(new URL("/socket-page", root).href, { workerId: 1, guard: admitAll });
        assert.deepEqual(reached, { popup: 0, serviceWorker: 0, webSocket: 1 });
    } finally {
        await browser.close();
        server.close();
    }
});

test("Browser.render: reused worker contexts keep page headers, policy, and failures isolated", async () => {
    const reached: Array<{ path: string; marker: string | undefined }> = [];
    const server = http.createServer((req, res) => {
        reached.push({ path: req.url ?? "", marker: req.headers["x-render-marker"] });
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><body>ok</body>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = new Browser();
    const root = urlOf(server);
    const guardPath = (path: string) => async (raw: string): Promise<GuardAdmission> =>
        new URL(raw).pathname === path
            ? { admitted: true }
            : { admitted: false, error: new GuardBlockedError(raw) };
    try {
        await Promise.all([
            browser.render(new URL("/a", root).href, {
                workerId: 7,
                headers: [["X-Render-Marker", "a"]],
                guard: guardPath("/a"),
            }),
            browser.render(new URL("/b", root).href, {
                workerId: 7,
                headers: [["X-Render-Marker", "b"]],
                guard: guardPath("/b"),
            }),
        ]);
        assert.deepEqual(reached.toSorted((a, b) => a.path.localeCompare(b.path)), [
            { path: "/a", marker: "a" },
            { path: "/b", marker: "b" },
        ]);

        const failure = new GuardBlockedError(new URL("/blocked", root).href);
        await assert.rejects(
            browser.render(new URL("/blocked", root).href, {
                workerId: 7,
                guard: async () => ({ admitted: false, error: failure }),
            }),
            (error: unknown) => error === failure,
        );
        await browser.render(new URL("/after", root).href, {
            workerId: 7,
            guard: guardPath("/after"),
        });
        assert.deepEqual(reached.at(-1), { path: "/after", marker: undefined });
    } finally {
        await browser.close();
        server.close();
    }
});

// Minimal conformant ctx recording the streamed chunks.
const makeCtx = () => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let closed: { result: SchemeResult; summary?: string } | null = null;
    const ok = async () => ({ status: 200 });
    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries: { read: async () => ({ status: 404, entry: null }), write: async () => ({ status: 201, created: true, entryId: 1 }), delete: ok },
        channels: { append: ok, replace: ok, setState: ok },
        tags: { add: ok, remove: ok, list: async () => ({ status: 200, tags: [] }) },
        notify: { streamEvent() {} },
        projection: {
            async readable(content) {
                return { content: content.replace(/<[^>]+>/g, " "), mimetype: "text/markdown" };
            },
        },
        subscriptions: {
            async open(_p: string, _h: SubscriptionHandle) { return new AbortController().signal; },
            async notifyChunk(channel, chunk, mimetype) { chunks.push({ channel, chunk, mimetype }); },
            async close(result, summary) { closed = { result, summary }; },
        },
    };
    return { ctx, inspect: () => ({ chunks, closed }) };
};

const readStmt = (raw: string): ReadStatement => {
    const url = new URL(raw);
    return {
        op: "READ", suffix: "READ", signal: null, body: null, lineMarker: null,
        position: { line: 0, column: 0 },
        target: {
            kind: "url",
            raw,
            scheme: url.protocol.slice(0, -1),
            username: null,
            password: null,
            hostname: url.hostname,
            port: url.port === "" ? null : Number.parseInt(url.port, 10),
            pathname: url.pathname,
            query: null,
            fragment: null,
        } as UrlPath,
    };
};

test("Http.read: full render path against real chromium — readable body + faithful DOM", async (t) => {
    t.mock.method(Guard, "admit", async () => ({ admitted: true }));
    const server = await startServer();
    const browser = new Browser();          // injected so the test owns teardown
    const { ctx, inspect } = makeCtx();
    try {
        const r = await new Http(browser).read(readStmt(urlOf(server)), ctx);
        assert.equal(r.status, 102);
        const body = inspect().chunks.filter((c) => c.channel === "body");
        assert.equal(body.length, 1);
        assert.match(body[0].chunk, /RENDERED_BY_JS/);   // real render, real JS
        assert.doesNotMatch(body[0].chunk, /SHIM/);
        assert.equal(body[0].mimetype, "text/markdown");
        const html = inspect().chunks.filter((c) => c.channel === "html");
        assert.match(html[0]?.chunk ?? "", /RENDERED_BY_JS/);
        assert.equal(html[0]?.mimetype, "text/html");
        assert.deepEqual(inspect().closed?.result, { status: 200 });
    } finally {
        await browser.close();
        server.close();
    }
});
