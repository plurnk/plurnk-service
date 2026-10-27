import test from "node:test";
import { buffer } from "node:stream/consumers";
import { createServer } from "node:http";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import type { ProposalResult, SchemeCtx, SchemeResult } from "@plurnk/plurnk-schemes";
import Http from "./Http.ts";
import {
    editSettled,
    editStmt,
    httpEdit,
    httpKill,
    httpSend,
    killSettled,
    killStmt,
    makeCtx,
    mockFetch,
    prepareRepresentation,
    priorEntry,
    projectionCaps,
    readStmt,
    sendSettled,
    sendStmt,
    urlTarget,
    withFetch,
} from "../test/harness.ts";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";

// ── SEND verbs ────────────────────────────────────────────────────────────
test("{§http-lifecycle} SEND: POSTs the body and streams the response", async () => {
    const { ctx, inspect } = makeCtx();
    let seenMethod = "", seenBody: unknown = null, seenType = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET"; seenBody = init?.body ?? null;
        seenType = new Headers(init?.headers).get("content-type") ?? "";
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("ok")); c.close(); } }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/plain" },
        });
    };
    await withFetch(probe, async () => {
        const r = await httpSend(sendStmt(urlTarget("https://example.com/p", "/p"), "payload", ["{\"Content-Type\":\"text/plain\"}"]), ctx);
        assert.equal(r.status, 102);
    });
    assert.equal(seenMethod, "POST");
    assert.equal(seenBody, "payload");
    assert.equal(seenType, "text/plain");
    assert.equal(inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join(""), "ok");
});

test("{§http-manifest} POST, PUT and the remote DELETE propose, and nothing leaves the process until settled", async () => {
    const target = urlTarget("https://example.com/p", "/p");
    const cases: ReadonlyArray<readonly [string, (http: Http, ctx: SchemeCtx) => Promise<SchemeResult>]> = [
        ["POST", (http, ctx) => http.send(sendStmt(target, "payload"), ctx)],
        ["PUT", (http, ctx) => http.edit(editStmt(target, "payload"), ctx)],
        ["DELETE", (http, ctx) => http.kill(killStmt(target, null, ["{\"remote\":true}"]), ctx)],
    ];
    for (const [method, propose] of cases) {
        const { ctx } = makeCtx();
        const http = new Http();
        let calls = 0;
        let seenMethod = "";
        const probe = async (_url: string | URL | Request, init?: RequestInit) => {
            calls += 1;
            seenMethod = init?.method ?? "GET";
            return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
        };
        await withFetch(probe, async () => {
            const proposal = await propose(http, ctx);
            assert.equal(proposal.status, 202, `${method} proposes`);
            assert.equal(calls, 0, `${method} reaches no origin before its settlement`);
            const attrs = (proposal as ProposalResult).attrs as { effect?: string; method?: string };
            assert.equal(attrs.effect, "host", `${method} declares the host effect the panel maps`);
            assert.equal(attrs.method, method);
            await http.applyResolution({ attrs: attrs, metadata: null }, ctx);
        });
        assert.equal(calls, 1, `${method} is sent exactly once, on acceptance`);
        assert.equal(seenMethod, method);
    }
});

test("{§http-manifest} a request header never enters the durable proposal attrs", async () => {
    const { ctx } = makeCtx();
    const http = new Http();
    const metadata = ["{\"Authorization\":\"Bearer s3cr3t-value\"}"];
    let seenAuthorization = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe, async () => {
        const statement = sendStmt(urlTarget("https://example.com/p", "/p"), "payload", metadata);
        const proposal = await http.send(statement, ctx);
        assert.equal(proposal.status, 202);
        const attrs = (proposal as ProposalResult).attrs as object;
        assert.ok(!JSON.stringify(attrs).includes("s3cr3t-value"), "the credential is not persisted in proposal evidence");
        // It survives the pause as statement metadata instead, and still reaches the origin.
        await http.applyResolution({ attrs, metadata: statement.metadata }, ctx);
    });
    assert.equal(seenAuthorization, "Bearer s3cr3t-value");
});

test("{§http-manifest} the resolver's body replaces the authored one before it is sent", async () => {
    const { ctx } = makeCtx();
    const http = new Http();
    let seenBody: unknown = null;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenBody = init?.body ?? null;
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe, async () => {
        const proposal = await http.send(sendStmt(urlTarget("https://example.com/p", "/p"), "authored"), ctx);
        const attrs = (proposal as ProposalResult).attrs as object;
        await http.applyResolution({ attrs, metadata: null, body: "settled" }, ctx);
    });
    assert.equal(seenBody, "settled");
});

test("{§http-status} SEND: an uncertain POST failure never recommends automatic replay", async () => {
    const { ctx } = makeCtx();
    await withFetch(async () => { throw new Error("connection reset after dispatch"); }, async () => {
        const result = await httpSend(
            sendStmt(urlTarget("https://example.com/effect", "/effect"), "payload"),
            ctx,
        );
        assert.equal(result.status, 502);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/fetch-failed");
        assert.equal(result.problem?.retryable, false, "the origin may already have accepted the POST");
    });
});

// ── request headers and method operations {§http-manifest} ───────────────────
test("{§http-lifecycle} READ: [metadata] headers are threaded into the fetch", async () => {
    const { ctx } = makeCtx();
    let seenHeaders: RequestInit["headers"];
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenHeaders = init?.headers;
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const target = urlTarget("https://api.x/v1/me", "/v1/me");
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(target, null, ["{\"Authorization\":\"Bearer T\",\"Accept\":\"application/json\"}"]), ctx);
    });
    // Plurnk's own identity rides first when the model supplied no UA block.
    assert(Array.isArray(seenHeaders));
    assert.deepEqual(seenHeaders, [["User-Agent", seenHeaders[0][1]], ["Authorization", "Bearer T"], ["Accept", "application/json"]]);
    assert.match(seenHeaders[0][1], /^PlurnkBot\//u);
});

test("{§slicer-text-algebra} HTTP rejects malformed metadata without reflecting its contents", async () => {
    const { ctx } = makeCtx();
    const secret = "Bearer do-not-reflect";
    const result = await prepareRepresentation(
        new Http(),
        readStmt(urlTarget("https://api.x/v1/me", "/v1/me"), null, [`Authorization ${secret}`]),
        ctx,
    );
    assert.equal(result.status, 400);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/metadata-invalid");
    assert.equal(result.problem?.detail, "[metadata] must be a JSON array."); // {§slicer-text-algebra}
    assert.doesNotMatch(JSON.stringify(result), /do-not-reflect/);
});

test("{§http-lifecycle} READ: headers reach direct fetch on an HTML GET (authed page requests authed)", async () => {
    const { ctx, inspect } = makeCtx();
    const target = urlTarget("https://app.x/dash", "/dash");
    let seenAuth = "";
    const seenUrls: string[] = [];
    await withFetch((async (url, init) => {
        seenUrls.push(requestUrl(url));
        seenAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("<html><body>authed</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }), async () => {
        await prepareRepresentation(new Http(), readStmt(target, null, ["{\"Authorization\":\"Bearer T\"}"]), ctx);
    });
    assert.equal(seenAuth, "Bearer T");
    assert.deepEqual(seenUrls, ["https://app.x/dash"], "explicit request metadata never authorizes the materializer");
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-materializer-id: local-projection:v1:ineligible$/m);
});

test("{§http-lifecycle} EDIT → PUT with the body (method mapping)", async () => {
    const { ctx, inspect } = makeCtx();
    let seenMethod = "", seenBody: unknown = null, seenType = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET"; seenBody = init?.body ?? null;
        seenType = new Headers(init?.headers).get("content-type") ?? "";
        return new Response("updated", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe, async () => {
        const r = await httpEdit(editStmt(
            urlTarget("https://api.x/thing/42", "/thing/42"),
            '{"done":true}',
            null,
            ["{\"Content-Type\":\"application/json\"}"],
        ), ctx);
        assert.equal(r.status, 102);
    });
    assert.equal(seenMethod, "PUT");
    assert.equal(seenBody, '{"done":true}');
    assert.equal(seenType, "application/json");
    assert.equal(inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join(""), "updated");
});

test("{§http-manifest} EDIT: a <L> line marker is rejected — http PUT replaces the whole resource", async () => {
    const { ctx } = makeCtx();
    const r = await httpEdit(editStmt(urlTarget("https://api.x/thing/42", "/thing/42"), "x", { marks: [1] }), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/http/line-edit-unsupported");
    assert.equal(r.problem?.recovery, "Remove the line range and submit the complete replacement body."); // {§http-manifest}
});

test("{§channel-selection} an absent HTTP response channel is a 404 without a remote mutation", async () => {
    const { ctx, inspect } = makeCtx();
    let requests = 0;
    await withFetch(async () => {
        requests++;
        return new Response("unexpected");
    }, async () => {
        const result = await httpEdit(editStmt(urlTarget("https://example.com/x", "/x", "unknown"), "replacement"), ctx);
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/channel-not-found");
        assert.equal(result.problem?.requestedChannel, "unknown");
        assert.deepEqual(result.problem?.availableChannels, ["body", "header", "readable"]);
    });
    assert.equal(requests, 0);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().opened, null);
});

test("{§revalidation} KILL {remote} sends DELETE with the authored precondition", async () => {
    const { ctx } = makeCtx();
    let seenMethod = "", seenVersion = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET";
        seenVersion = new Headers(init?.headers).get("if-match") ?? "";
        return new Response(null, { status: 204, statusText: "No Content" });
    };
    await withFetch(probe, async () => {
        const r = await httpKill(killStmt(
            urlTarget("https://api.x/thing/42", "/thing/42"),
            null,
            ["{\"remote\": true, \"If-Match\": \"\\\"revision-7\\\"\"}"],
        ), ctx);
        assert.equal(r.status, 102);
    });
    assert.equal(seenMethod, "DELETE");
    assert.equal(seenVersion, '"revision-7"');
});

// {§revalidation} — a KILL follows the entry rule; only `{remote}` reaches the remote.
test("{§http-lifecycle} KILL without {remote} forgets the stored response and never contacts the remote", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("stored page", "text/markdown", ""));
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        return new Response(null, { status: 204 });
    }), async () => {
        const r = await httpKill(killStmt(urlTarget("https://api.x/thing/42", "/thing/42")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(inspect().deleted, "/thing/42", "the local stored entry is forgotten");
    assert.equal(calls, 0, "no request reaches the remote");
});

test("{§http-lifecycle} KILL of a live acquisition cancels it in place, and the owner settles 499", async () => {
    const { ctx, inspect } = makeCtx();
    const http = new Http();
    const target = urlTarget("https://api.x/slow", "/slow");
    const methods: string[] = [];
    const pending = { fetch: null as Promise<Response> | null };
    await withFetch(((_url: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        const signal = init?.signal;
        pending.fetch = new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return pending.fetch;
    }), async () => {
        const acquisition = prepareRepresentation(http, readStmt(target), ctx);
        await new Promise((done) => setTimeout(done, 20));
        const killed = await http.kill(killStmt(target), ctx);
        assert.equal(killed.status, 200, "the KILL answers once the acquisition is aborted");
        const settled = await acquisition;
        assert.equal(settled.status, 499, "the interrupted GET settles as cancelled");
    });
    assert.deepEqual(methods, ["GET"], "only the acquisition touched the network; no DELETE was sent");
    assert.equal(inspect().deleted, null, "a cancelled acquisition forgets nothing it never stored");
});

test("{§http-lifecycle} KILL cancels a binary GET after headers, before publishing any partial bytes", { timeout: 3000 }, async (t) => {
    const reading = Promise.withResolvers<void>();
    const outer = new AbortController();
    const { ctx, inspect } = makeCtx(null, { signal: outer.signal, projection: projectionCaps({
        async binary(chunks, mimetype) {
            const input = (async function* () {
                for await (const chunk of chunks) { reading.resolve(); yield chunk; }
            })();
            return { bytes: await buffer(input), readable: null, projectionIdentity: mimetype };
        },
    }) });
    const http = new Http();
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write(Uint8Array.of(1, 2, 3));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); return new Promise<void>((done) => server.close(() => done())); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const target = urlTarget(`http://127.0.0.1:${address.port}/slow.bin`, "/slow.bin");
    const acquisition = prepareRepresentation(http, readStmt(target), ctx);
    try {
        await reading.promise;
        assert.equal((await http.kill(killStmt(target), ctx)).status, 200);
        const settled = await Promise.race([acquisition, new Promise<never>((_resolve, reject) => {
            // A liveness bound: the server holds the body open, so an uncancelled GET never settles.
            const timer = setTimeout(() => reject(new Error("GET body was not cancelled")), 20_000);
            timer.unref();
        })]);
        assert.equal(settled.status, 499);
        assert.equal(inspect().wrote, null);
    } finally {
        outer.abort();
        await acquisition;
    }
});

// ── acquisition target rewrite {§revalidation} ────────────────────────────
test("{§http-lifecycle} GitHub blob → raw.githubusercontent rewrite (code wants source, not the SPA)", async () => {
    const { ctx, inspect } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => {
        seenUrl = requestUrl(url);
        return new Response("// source", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget(blob, "/nodejs/node/blob/main/src/node_version.h")), ctx);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h");
    assert.equal(inspect().wrote?.pathname, "/nodejs/node/blob/main/src/node_version.h");
});

test("{§http-lifecycle} GitHub blob rewrite preserves a slash-bearing branch ref", async () => {
    const { ctx } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => { seenUrl = requestUrl(url); return new Response("x", { status: 200 }); };
    const blob = "https://github.com/o/r/blob/feature/foo/src/x.js";
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget(blob, "/o/r/blob/feature/foo/src/x.js")), ctx);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/o/r/feature/foo/src/x.js");
});

test("{§http-lifecycle} non-GitHub URL is fetched verbatim (no rewrite)", async () => {
    const { ctx } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => { seenUrl = requestUrl(url); return new Response("ok", { status: 200 }); };
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/x", "/x")), ctx);
    });
    assert.equal(seenUrl, "https://example.com/x");
});

test("{§revalidation} POST/PUT/DELETE preserve the addressed GitHub blob target", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const markers: string[] = [];
    const blob = "https://github.com/o/r/blob/main/src/x.js";
    await withFetch(async (url, init) => {
        seen.push({ url: requestUrl(url), method: init?.method ?? "GET" });
        return new Response(null, { status: 204 });
    }, async () => {
        const target = urlTarget(blob, "/o/r/blob/main/src/x.js");
        const operations = [
            (http: Http, ctx: SchemeCtx) => sendSettled(http, sendStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => editSettled(http, editStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => killSettled(http, killStmt(target, null, ["{\"remote\":true}"]), ctx),
        ];
        for (const operation of operations) {
            const { ctx, inspect } = makeCtx();
            assert.equal((await operation(new Http(), ctx)).status, 102);
            const header = inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "";
            markers.push(/^x-plurnk-request-method:[ \t]*(.+)$/im.exec(header)?.[1].trim() ?? "");
        }
    });
    assert.deepEqual(seen, [
        { url: blob, method: "POST" },
        { url: blob, method: "PUT" },
        { url: blob, method: "DELETE" },
    ]);
    assert.deepEqual(markers, ["POST", "PUT", "DELETE"]);
});

test("{§http-lifecycle} SEND: an HTML response streams body text as text/html", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["<html>body</html>"], { "content-type": "text/html" }), async () => {
        await httpSend(sendStmt(urlTarget("https://example.com/p", "/p"), "payload"), ctx);
    });
    const body = inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "<html>body</html>");
});
