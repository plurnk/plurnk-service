// Contract tests for the capability ctx (ctx.ts). This module exports
// INTERFACES only — plurnk-service injects the real db-backed impl. What we
// guard here is that the contract is *satisfiable* and the shapes compose:
// a minimal conformant impl that exercises every namespace, doubling as
// executable documentation of the intended call surface. If a future edit
// breaks an interface shape, this stops compiling (tsc) and the behavioral
// assertions stop passing.

import test from "node:test";
import { strict as assert } from "node:assert";
import type {
    SchemeCtx,
    EntryCaps,
    ChannelCaps,
    NotifyCaps,
    ProjectionCaps,
    SubscriptionCaps,
    SubscriptionHandle,
    StreamSubscription,
    ProposalAware,
    EntryData,
    StoredEntryData,
    ChannelState,
} from "./ctx.ts";
import Results from "./Results.ts";

// ── a minimal in-memory conformant implementation ─────────────────────────
// Backs `entries`/`channels` with a Map so the assertions are real, not
// vacuous. Records notify + subscription calls so we can assert the fused /
// composite contracts.

const makeCtx = () => {
    const store = new Map<string, StoredEntryData>();
    const events: string[] = [];
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let woken = 0;
    let closed: {
        result: Parameters<SubscriptionCaps["close"]>[0];
        summary?: string;
        channelResults?: Parameters<SubscriptionCaps["close"]>[2];
    } | null = null;
    const failure = <T extends Readonly<Record<string, unknown>> = Record<never, never>>(
        code: string,
        status: number,
        detail: string,
        fields: T = {} as T,
    ) => Results.failure("scheme:test", code, status, detail, fields) as ReturnType<typeof Results.failure> & T;

    const entries: EntryCaps = {
        operations: {
            async editBatch() {
                return failure("operation-not-implemented", 501, "EDIT is not implemented.", { entryId: null, channel: null });
            },
            async read() {
                return failure("operation-not-implemented", 501, "READ is not implemented.", { content: null, mimetype: null, channel: null });
            },
            async find() {
                return failure("operation-not-implemented", 501, "FIND is not implemented.", {
                    content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                    matchingPathCount: 0, matchLocationCount: 0,
                });
            },
            async send() {
                return failure("operation-not-implemented", 501, "SEND is not implemented.");
            },
        },
        async read(pathname) {
            const entry = store.get(pathname) ?? null;
            return entry === null
                ? failure("entry-not-found", 404, `No entry exists at ${pathname}.`, { entry: null })
                : Results.assert({ status: 200, entry });
        },
        async write(pathname, entry) {
            const created = !store.has(pathname);
            store.set(pathname, {
                channels: Object.fromEntries(Object.entries(entry.channels).map(([name, channel]) => [
                    name,
                    { ...channel, state: channel.state ?? "static" },
                ])),
                ...(entry.attributes === undefined ? {} : { attributes: entry.attributes }),
            });
            return { status: created ? 201 : 200, created, entryId: 1 };
        },
        async delete(pathname) {
            return store.delete(pathname)
                ? Results.assert({ status: 200 })
                : failure("entry-not-found", 404, `No entry exists at ${pathname}.`);
        },
    };

    const channels: ChannelCaps = {
        async append(pathname, channel, content) {
            const e = store.get(pathname);
            if (!e) return failure("entry-not-found", 404, `No entry exists at ${pathname}.`);
            const prev = e.channels[channel];
            store.set(pathname, {
                ...e,
                channels: { ...e.channels, [channel]: {
                    content: (prev?.content ?? "") + content,
                    mimetype: prev?.mimetype ?? "text/markdown",
                    state: prev?.state ?? "static",
                } },
            });
            return { status: 200 };
        },
        async replace(pathname, channel, content) {
            const e = store.get(pathname);
            if (!e) return failure("entry-not-found", 404, `No entry exists at ${pathname}.`);
            const previous = e.channels[channel];
            store.set(pathname, { ...e, channels: { ...e.channels, [channel]: {
                content,
                mimetype: previous?.mimetype ?? "text/markdown",
                state: previous?.state ?? "static",
            } } });
            return { status: 200 };
        },
        async setState(pathname, channel, state: ChannelState) {
            const entry = store.get(pathname);
            const previous = entry?.channels[channel];
            if (entry === undefined) return failure("entry-not-found", 404, `No entry exists at ${pathname}.`);
            if (previous === undefined) return failure("channel-not-found", 404, `No channel ${channel} exists at ${pathname}.`);
            store.set(pathname, {
                ...entry,
                channels: { ...entry.channels, [channel]: { ...previous, state } },
            });
            return { status: 200 };
        },
    };

    const notify: NotifyCaps = {
        streamEvent(pathname, channel, state, contentLength) {
            events.push(`${pathname}#${channel}:${state}:${contentLength}`);
        },
    };
    const projection: ProjectionCaps = {
        async readable(content, mimetype) {
            return content.length > 0 ? {
                content,
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: `${mimetype}-projection`,
            } : null;
        },
        async readableBytes(_chunks, mimetype) {
            return {
                content: "projected bytes",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: `${mimetype}-projection`,
            };
        },
        async identity(mimetype) {
            return `${mimetype}-projection`;
        },
        async isBinary(mimetype) {
            return mimetype === "application/pdf";
        },
        async parseIssues() {
            return undefined;
        },
    };

    let current: StreamSubscription | null = null;
    const notifyChunk: StreamSubscription["notifyChunk"] = async (channel, chunk, mimetype) => {
        // The contract: this is FUSED — append AND emit an event together.
        // Optional mimetype retypes the channel to the per-call content type.
        chunks.push({ channel, chunk, mimetype });
        notify.streamEvent("sub", channel, "active", chunk.length);
    };
    const close: StreamSubscription["close"] = async (result, summary, channelResults) => {
        closed = {
            result,
            ...(summary === undefined ? {} : { summary }),
            ...(channelResults === undefined ? {} : { channelResults }),
        };
        woken += 1;
    };
    const subscriptions: SubscriptionCaps = {
        async open(_pathname, _handle: SubscriptionHandle) {
            current = Object.assign(new AbortController().signal, { notifyChunk, close });
            return current;
        },
        async notifyChunk(channel, chunk, mimetype) {
            if (current === null) throw new Error("no open subscription");
            await current.notifyChunk(channel, chunk, mimetype);
        },
        // close composites the worker wake — there is no separate notify.wakeWorker;
        // the rich, summary-bearing wake lives where the close context is.
        async close(result, summary, channelResults) {
            if (current === null) throw new Error("no open subscription");
            await current.close(result, summary, channelResults);
        },
    };

    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, notify, projection,
        interactions: { request: async () => ({ status: "cancelled" }) },
        subscriptions,
    };

    return { ctx, inspect: () => ({ events, chunks, woken, closed }) };
};

test("ctx: entries cap does real CRUD scoped to the store", async () => {
    const { ctx } = makeCtx();
    const data: EntryData = {
        channels: { body: { content: "hi", mimetype: "text/markdown" } },
        attributes: { kind: "note" },
    };
    assert.equal((await ctx.entries.read("notes:///x")).status, 404);
    const w = await ctx.entries.write("notes:///x", data);
    assert.equal(w.status, 201);
    assert.equal(w.created, true);
    const r = await ctx.entries.read("notes:///x");
    assert.equal(r.status, 200);
    assert.equal(r.entry?.channels.body.content, "hi");
    assert.equal(r.entry?.channels.body.state, "static");
    assert.deepEqual(r.entry?.attributes, { kind: "note" });
    assert.equal((await ctx.entries.delete("notes:///x")).status, 200);
    assert.equal((await ctx.entries.read("notes:///x")).status, 404);
});

test("ctx: channels append accumulates (append-only store)", async () => {
    const { ctx } = makeCtx();
    await ctx.entries.write("notes:///x", { channels: {} });
    await ctx.channels.append("notes:///x", "body", "foo");
    await ctx.channels.append("notes:///x", "body", "bar");
    const r = await ctx.entries.read("notes:///x");
    assert.equal(r.entry?.channels.body.content, "foobar");
});

test("ctx: subscriptions.open returns an awaitable AbortSignal", async () => {
    const { ctx } = makeCtx();
    const handle: SubscriptionHandle = { cancel() {} };
    const signal = await ctx.subscriptions.open("exec://r-1", handle);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
});

test("ctx: the opened subscription is the retainable chunk and settlement capability", async () => {
    const { ctx, inspect } = makeCtx();
    const subscription = await ctx.subscriptions.open("exec://r-1", { cancel() {} });

    await subscription.notifyChunk("stdout", "detached\n", "text/plain");
    await subscription.close({ status: 200 }, "detached complete");

    assert.deepEqual(inspect().chunks, [{ channel: "stdout", chunk: "detached\n", mimetype: "text/plain" }]);
    assert.deepEqual(inspect().closed, { result: { status: 200 }, summary: "detached complete" });
});

test("ctx: notifyChunk is fused — one call appends AND emits an event", async () => {
    const { ctx, inspect } = makeCtx();
    await ctx.subscriptions.open("exec://r-1", { cancel() {} });
    await ctx.subscriptions.notifyChunk("stdout", "line1\n");
    await ctx.subscriptions.notifyChunk("stderr", "warn\n");
    const { chunks, events } = inspect();
    assert.equal(chunks.length, 2);
    // The fusion contract: each notifyChunk produced exactly one stream event.
    assert.equal(events.length, 2);
    assert.match(events[0], /stdout:active:6/);
});

test("ctx: notifyChunk carries an optional per-call mimetype (channel retype)", async () => {
    const { ctx, inspect } = makeCtx();
    await ctx.subscriptions.open("exec://r-1", { cancel() {} });
    await ctx.subscriptions.notifyChunk("body", "<html>hi</html>", "text/html");
    await ctx.subscriptions.notifyChunk("body", "more"); // omitted → channel keeps its type
    const { chunks } = inspect();
    assert.equal(chunks[0].mimetype, "text/html");
    assert.equal(chunks[1].mimetype, undefined);
});

test("ctx: subscriptions.close composites state + wake (stream concluded)", async () => {
    const { ctx, inspect } = makeCtx();
    await ctx.subscriptions.open("exec://r-1", { cancel() {} });
    await ctx.subscriptions.close(
        { status: 200 },
        "exit=0 bytes=42",
        { stderr: Results.failure("scheme:test", "stderr-failed", 500, "The stderr channel failed.") },
    );
    const { closed, woken } = inspect();
    assert.deepEqual(closed, {
        result: { status: 200 },
        summary: "exit=0 bytes=42",
        channelResults: {
            stderr: Results.failure("scheme:test", "stderr-failed", 500, "The stderr channel failed."),
        },
    });
    assert.equal(woken, 1); // close fires the worker wake
});

test("ctx: ProposalAware hook applies a resolution and returns a result", async () => {
    const { ctx } = makeCtx();
    // proposals are NOT an injected cap — a scheme implements this hook and
    // the engine calls it on accept. Minimal conformant scheme:
    const scheme: ProposalAware = {
        async applyResolution(request, c) {
            assert.deepEqual(request, { attrs: { pathname: "file://x" }, body: "applied" });
            await c.entries.write("file://x", { channels: { body: { content: request.body ?? "", mimetype: "text/markdown" } } });
            return { status: 200, outcome: "applied" };
        },
    };
    const out = await scheme.applyResolution({ attrs: { pathname: "file://x" }, body: "applied" }, ctx);
    assert.equal(out.status, 200);
    assert.equal((await ctx.entries.read("file://x")).entry?.channels.body.content, "applied");
});
