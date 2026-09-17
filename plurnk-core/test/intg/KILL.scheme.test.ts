import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Http, Ws } from "@plurnk/plurnk-schemes-http";
import type { SchemeHandler } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope, seedEntryWithChannel } from "./_helpers.ts";

const statement = (header: string) => {
    const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, null));
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    assert.ok(item?.kind === "statement");
    return item.statement;
};

test("{§scheme-operation-dispatch}: KILL receives the authored statement and bound resource capabilities", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `scheme-kill-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    const requested = statement('KILL (owned://bucket/notes) <1,-1> [{"mode":"local"}] <!-- remove -->');
    let invoked = false;
    schemes.register("owned", {
        manifest: { name: "owned", authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body", category: "data", writableBy: ["model"], volatile: false, modelVisible: true, metadataModifier: true },
        async kill(received, ctx) {
            assert.deepEqual(received, requested, "all authored KILL fields reach the owner");
            assert.equal(ctx.workspaceId, env.workspaceId);
            assert.equal(ctx.workerId, env.workerId);
            assert.equal(ctx.writer, "model");
            const prior = await ctx.entries.read("/notes");
            assert.equal(prior.entry?.channels.body.content, "selected namespace");
            invoked = true;
            return ctx.entries.delete("/notes");
        },
    } satisfies SchemeHandler);
    const engine = new Engine({ db, schemes });
    try {
        await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "owned", authority: "bucket", pathname: "/notes", content: "selected namespace" });
        await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "owned", pathname: "/notes", content: "other namespace" });
        const result = await engine.dispatch({ ...env, statement: requested, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(invoked, true);
        const survivor = await engine.dispatch({ ...env, statement: statement("READ (owned:///notes)"), sequence: 2, origin: "model" });
        assert.equal(survivor.content, "other namespace");
        const deleted = await engine.dispatch({ ...env, statement: statement("READ (owned://bucket/notes)"), sequence: 3, origin: "model" });
        assert.equal(deleted.status, 404);
    } finally {
        await schemes.close();
        await db.close();
    }
});

for (const protocol of ["https", "http"]) {
    test(`{§http-kill}: dispatched ${protocol} KILL separates local deletion from explicit remote DELETE`, async (t) => {
        const db = await openMigrated();
        const env = await seedEnvelope(db, `http-kill-${crypto.randomUUID()}`);
        const schemes = new SchemeRegistry();
        schemes.register("https", new Http());
        const engine = new Engine({ db, schemes });
        const requests: Array<{ method: string; condition: string | null; url: string }> = [];
        t.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
            requests.push({ method: init?.method ?? "GET", condition: new Headers(init?.headers).get("if-match"), url: String(url) });
            return new Response(null, { status: 204 });
        });
        try {
            const target = `${protocol}://93.184.216.34/record?revision=7`;
            await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: protocol, authority: "93.184.216.34", pathname: "/record?revision=7", content: "stored response" });
            const local = await engine.dispatch({ ...env, statement: statement(`KILL (${target})`), sequence: 1, origin: "model" });
            assert.equal(local.status, 200, JSON.stringify(local));
            assert.deepEqual(requests, [], "forgetting a response cannot perform a remote mutation");
            const repeated = await engine.dispatch({ ...env, statement: statement(`KILL (${target})`), sequence: 2, origin: "model" });
            assert.equal(repeated.status, 404, "the local representation was actually removed");
            const remote = await engine.dispatch({ ...env, statement: statement(`KILL (${target}) [{"remote":true,"If-Match":"revision-7"}]`), sequence: 3, origin: "model" });
            assert.equal(remote.status, 102, JSON.stringify(remote));
            assert.deepEqual(requests, [{ method: "DELETE", condition: "revision-7", url: target }]);
        } finally {
            await schemes.close();
            await db.close();
        }
    });
}

for (const protocol of ["wss", "ws"]) {
    test(`{§ws-lifecycle}: dispatched ${protocol} KILL closes the socket and settles its durable subscription`, async () => {
        const db = await openMigrated();
        const env = await seedEnvelope(db, `ws-kill-${crypto.randomUUID()}`);
        const schemes = new SchemeRegistry();
        const handlers = new Map<string, (event: { code?: number; reason?: string }) => void>();
        const closed: Array<{ code?: number; reason?: string }> = [];
        schemes.register("wss", new Ws(() => {
            setImmediate(() => handlers.get("open")?.({}));
            return {
                readyState: 1,
                addEventListener: (name, listener) => { handlers.set(name, listener); },
                send: () => { throw new Error("KILL does not send socket data"); },
                close: (code, reason) => {
                    closed.push({ code, reason });
                    handlers.get("close")?.({ code, reason });
                },
            };
        }));
        const engine = new Engine({ db, schemes });
        try {
            const target = `${protocol}://93.184.216.34/feed`;
            const opened = await engine.dispatch({ ...env, statement: statement(`READ (${target})`), sequence: 1, origin: "model" });
            assert.equal(opened.status, 102, JSON.stringify(opened));
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: protocol, pathname: "/feed" });
            assert.ok(entry);
            const live = await db.test_get_subscription_by_entry.get<{ closed_at: string | null }>({ worker_id: env.workerId, entry_id: entry.id });
            assert.equal(live?.closed_at, null);
            const killed = await engine.dispatch({ ...env, statement: statement(`KILL (${target})`), sequence: 2, origin: "model" });
            assert.equal(killed.status, 200, JSON.stringify(killed));
            assert.deepEqual(closed, [{ code: 1000, reason: "killed" }]);
            await schemes.close();
            const terminal = await db.test_get_subscription_by_entry.get<{ close_status: number; closed_at: string | null }>({ worker_id: env.workerId, entry_id: entry.id });
            assert.equal(terminal?.close_status, 200, "an opened socket's normal close is a successful terminal result");
            assert.ok(terminal?.closed_at);
        } finally {
            await schemes.close();
            await db.close();
        }
    });
}
