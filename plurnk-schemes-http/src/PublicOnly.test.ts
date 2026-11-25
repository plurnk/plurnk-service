// {§http-host-policy} — PLURNK_SCHEMES_HTTP_PUBLIC_ONLY enforcement across direct HTTP GET,
// POST/PUT/DELETE (including redirect hops), WebSocket upgrades, and configuration validation.
// Fully hermetic: mocked fetch / fake sockets and IP-literal URLs (no DNS or real network).

import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { NetworkAddress } from "@plurnk/plurnk-schemes";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";
import Http from "./Http.ts";
import WebFetcher from "./WebFetcher.ts";
import Ws from "./Ws.ts";
import {
    editStmt,
    httpEdit,
    httpKill,
    httpSend,
    killStmt,
    makeCtx,
    prepareRepresentation,
    readStmt,
    sendStmt,
    urlTarget,
    withFetch,
} from "../test/harness.ts";

const withEnv = async (
    overrides: Record<string, string | undefined>,
    run: () => Promise<void> | void,
): Promise<void> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        await run();
    } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

test("{§http-host-policy} WebFetcher.validateConfiguration validates PLURNK_SCHEMES_HTTP_PUBLIC_ONLY as 0 or 1", async () => {
    for (const valid of ["0", "1"]) {
        await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: valid }, () => {
            assert.doesNotThrow(() => WebFetcher.validateConfiguration());
        });
    }
    for (const invalid of ["", "yes", "2", "true"]) {
        await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: invalid }, () => {
            assert.throws(
                () => WebFetcher.validateConfiguration(),
                (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SCHEMES_HTTP_PUBLIC_ONLY",
            );
        });
    }
});

test("{§http-host-policy} PLURNK_SCHEMES_HTTP_PUBLIC_ONLY=1 blocks private GET targets and redirects into private space", async () => {
    await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: "1", PLURNK_SCHEMES_HTTP_HOSTS: "" }, async () => {
        for (const privateUrl of [
            "http://127.0.0.1:8080/secret",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/secret",
        ]) {
            const { ctx } = makeCtx();
            let called = false;
            await withFetch(async () => {
                called = true;
                return new Response("leaked", { status: 200, headers: { "content-type": "text/plain" } });
            }, async () => {
                const res = await prepareRepresentation(new Http(), readStmt(urlTarget(privateUrl, new URL(privateUrl).pathname)), ctx);
                assert.equal(res.status, 403);
                assert.equal(res.problem?.type.endsWith("/url-not-public"), true);
            }, false);
            assert.equal(called, false, `${privateUrl} must be blocked before any fetch leaves the process`);
        }

        // Redirect from public IP into loopback is refused before hitting loopback.
        const { ctx: redirectCtx } = makeCtx();
        const seen: string[] = [];
        await withFetch(async (u) => {
            const href = requestUrl(u);
            seen.push(href);
            if (href.includes("8.8.8.8")) {
                return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
            }
            return new Response("private-secret", { status: 200, headers: { "content-type": "text/plain" } });
        }, async () => {
            const res = await prepareRepresentation(new Http(), readStmt(urlTarget("http://8.8.8.8/start", "/start")), redirectCtx);
            assert.equal(res.status, 403);
            assert.equal(res.problem?.type.endsWith("/url-not-public"), true);
        }, false);
        assert.deepEqual(seen, ["http://8.8.8.8/start"]);

        // Public IP literal succeeds cleanly.
        const { ctx: pubCtx } = makeCtx();
        await withFetch(async () => new Response("public-ok", { status: 200, headers: { "content-type": "text/plain" } }), async () => {
            const res = await prepareRepresentation(new Http(), readStmt(urlTarget("https://93.184.216.34/doc", "/doc")), pubCtx);
            assert.equal(res.status, 200);
        }, false);
    });

    // Host policy refusal on redirect surfaces host-not-permitted rather than url-not-public.
    await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: "1", PLURNK_SCHEMES_HTTP_HOSTS: '["8.8.8.8"]' }, async () => {
        const { ctx } = makeCtx();
        await withFetch(async () => new Response(null, { status: 302, headers: { location: "http://1.1.1.1/other" } }), async () => {
            const res = await prepareRepresentation(new Http(), readStmt(urlTarget("http://8.8.8.8/start", "/start")), ctx);
            assert.equal(res.status, 403);
            assert.equal(res.problem?.type.endsWith("/host-not-permitted"), true);
        }, false);
    });
});

test("{§http-host-policy} PLURNK_SCHEMES_HTTP_PUBLIC_ONLY=1 blocks private POST/PUT/DELETE targets and redirect hops before bytes leave", async () => {
    await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: "1", PLURNK_SCHEMES_HTTP_HOSTS: "" }, async () => {
        const privateTarget = urlTarget("http://127.0.0.1:8080/admin", "/admin");
        const calls = [
            (ctx: ReturnType<typeof makeCtx>["ctx"]) => httpSend(sendStmt(privateTarget, "payload"), ctx),
            (ctx: ReturnType<typeof makeCtx>["ctx"]) => httpEdit(editStmt(privateTarget, "payload"), ctx),
            (ctx: ReturnType<typeof makeCtx>["ctx"]) => httpKill(killStmt(privateTarget, null, { remote: true }), ctx),
        ];
        for (const runOp of calls) {
            const { ctx, awaitClosed } = makeCtx();
            let fetched = false;
            await withFetch(async () => {
                fetched = true;
                return new Response("leaked", { status: 200 });
            }, async () => {
                const res = await runOp(ctx);
                assert.equal(res.status, 403);
                assert.equal(res.problem?.type.endsWith("/url-not-public"), true);
                const settled = await awaitClosed();
                assert.equal(settled.result.status, 403);
                assert.equal(settled.result.problem?.type.endsWith("/url-not-public"), true);
            }, false);
            assert.equal(fetched, false);
        }

        // Public POST redirecting into IMDS is blocked hop-by-hop before IMDS is touched.
        const { ctx: redirCtx, awaitClosed } = makeCtx();
        const seen: string[] = [];
        await withFetch(async (u) => {
            const href = requestUrl(u);
            seen.push(href);
            if (href.includes("8.8.8.8")) {
                return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
            }
            return new Response("imds-secret", { status: 200 });
        }, async () => {
            const res = await httpSend(sendStmt(urlTarget("http://8.8.8.8/hook", "/hook"), "hi"), redirCtx);
            assert.equal(res.status, 403);
            assert.equal(res.problem?.type.endsWith("/url-not-public"), true);
            const settled = await awaitClosed();
            assert.equal(settled.result.status, 403);
            assert.equal(settled.result.problem?.type.endsWith("/url-not-public"), true);
        }, false);
        assert.deepEqual(seen, ["http://8.8.8.8/hook"]);

        // Public POST succeeds cleanly under PUBLIC_ONLY=1.
        const { ctx: pubCtx, inspect, awaitClosed: awaitPub } = makeCtx();
        await withFetch(async () => new Response("accepted", { status: 200, headers: { "content-type": "text/plain" } }), async () => {
            const start = await httpSend(sendStmt(urlTarget("https://93.184.216.34/api", "/api"), "hi"), pubCtx);
            assert.equal(start.status, 102);
            const settled = await awaitPub();
            assert.equal(settled.result.status, 200);
        }, false);
        assert.equal(inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join(""), "accepted");
    });
});

test("{§http-host-policy} PLURNK_SCHEMES_HTTP_PUBLIC_ONLY=1 blocks private WebSocket targets before socket construction and admits public targets", async () => {
    const prepareWs = (ws: Ws, raw: string, ctx: ReturnType<typeof makeCtx>["ctx"]) => {
        const target = urlTarget(raw, new URL(raw).pathname);
        const address = NetworkAddress.from(target);
        return ws.prepareRepresentation({
            target,
            headers: null,
            authority: address.authority,
            pathname: address.pathname,
        }, ctx);
    };

    await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: "1", PLURNK_SCHEMES_HTTP_HOSTS: "" }, async () => {
        for (const privateWs of ["ws://127.0.0.1:9000/feed", "wss://169.254.169.254/feed", "ws://localhost/feed"]) {
            let connected = false;
            const ws = new Ws(() => {
                connected = true;
                throw new Error("socket should never be opened");
            });
            const { ctx } = makeCtx();
            const res = await prepareWs(ws, privateWs, ctx);
            assert.equal(res.status, 403);
            assert.equal(res.problem?.type.endsWith("/url-not-public"), true);
            assert.equal(connected, false);
        }

        // Public WebSocket IP literal reaches socket factory.
        let openedUrl = "";
        const ws = new Ws((url) => {
            openedUrl = url;
            const listeners = new Map<string, (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void>();
            const sock = {
                readyState: 0,
                addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void) {
                    listeners.set(type, fn);
                },
                send() {},
                close() { sock.readyState = 3; listeners.get("close")?.({ code: 1000, reason: "" }); },
            };
            queueMicrotask(() => {
                sock.readyState = 1;
                listeners.get("open")?.({});
            });
            return sock;
        });
        const { ctx } = makeCtx();
        const res = await prepareWs(ws, "wss://93.184.216.34/feed", ctx);
        assert.equal(res.status, 102);
        assert.equal(openedUrl, "wss://93.184.216.34/feed");
        await ws.close();
    });

    // Default PLURNK_SCHEMES_HTTP_PUBLIC_ONLY=0 preserves loopback HTTP and WS access.
    await withEnv({ PLURNK_SCHEMES_HTTP_PUBLIC_ONLY: "0", PLURNK_SCHEMES_HTTP_HOSTS: "" }, async () => {
        const { ctx } = makeCtx();
        await withFetch(async () => new Response("local-ok", { status: 200, headers: { "content-type": "text/plain" } }), async () => {
            const res = await prepareRepresentation(new Http(), readStmt(urlTarget("http://127.0.0.1:8080/local", "/local")), ctx);
            assert.equal(res.status, 200);
        });
        let openedLoopback = false;
        const ws = new Ws(() => {
            openedLoopback = true;
            const listeners = new Map<string, (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void>();
            const sock = {
                readyState: 0,
                addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void) {
                    listeners.set(type, fn);
                },
                send() {},
                close() { sock.readyState = 3; listeners.get("close")?.({ code: 1000, reason: "" }); },
            };
            queueMicrotask(() => {
                sock.readyState = 1;
                listeners.get("open")?.({});
            });
            return sock;
        });
        const { ctx: wsCtx } = makeCtx();
        const wsRes = await prepareWs(ws, "ws://127.0.0.1:9000/local", wsCtx);
        assert.equal(wsRes.status, 102);
        assert.equal(openedLoopback, true);
        await ws.close();
    });
});
