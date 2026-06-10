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
    TagCaps,
    NotifyCaps,
    SubscriptionCaps,
    CrossSchemeCaps,
    SubscriptionHandle,
    ProposalAware,
    EntryData,
    ChannelState,
} from "./ctx.ts";
import type { ProposalResult, SchemeResult } from "./results.ts";

// ── a minimal in-memory conformant implementation ─────────────────────────
// Backs `entries`/`channels` with a Map so the assertions are real, not
// vacuous. Records notify + subscription calls so we can assert the fused /
// composite contracts.

const makeCtx = () => {
    const store = new Map<string, EntryData>();
    const events: string[] = [];
    const chunks: Array<{ channel: string; chunk: string }> = [];
    let woken = 0;
    let closed: { reason: string; outcome?: string } | null = null;

    const entries: EntryCaps = {
        async read(pathname) {
            const entry = store.get(pathname) ?? null;
            return { status: entry ? 200 : 404, entry };
        },
        async write(pathname, entry) {
            const created = !store.has(pathname);
            store.set(pathname, entry);
            return { status: created ? 201 : 200, created, entryId: 1 };
        },
        async delete(pathname) {
            return { status: store.delete(pathname) ? 200 : 404 };
        },
    };

    const channels: ChannelCaps = {
        async append(pathname, channel, content) {
            const e = store.get(pathname);
            if (!e) return { status: 404 };
            const prev = e.channels[channel];
            store.set(pathname, {
                ...e,
                channels: { ...e.channels, [channel]: { content: (prev?.content ?? "") + content, mimetype: prev?.mimetype ?? "text/markdown" } },
            });
            return { status: 200 };
        },
        async replace(pathname, channel, content) {
            const e = store.get(pathname);
            if (!e) return { status: 404 };
            store.set(pathname, { ...e, channels: { ...e.channels, [channel]: { content, mimetype: e.channels[channel]?.mimetype ?? "text/markdown" } } });
            return { status: 200 };
        },
        async setState(_pathname, _channel, _state: ChannelState) {
            return { status: 200 };
        },
    };

    const tags: TagCaps = {
        async add(pathname) { return { status: store.has(pathname) ? 200 : 404 }; },
        async remove(pathname) { return { status: store.has(pathname) ? 200 : 404 }; },
        async list(pathname) { return { status: store.has(pathname) ? 200 : 404, tags: store.get(pathname)?.tags ?? [] }; },
    };

    const notify: NotifyCaps = {
        streamEvent(pathname, channel, state, contentLength) {
            events.push(`${pathname}#${channel}:${state}:${contentLength}`);
        },
    };

    const subscriptions: SubscriptionCaps = {
        async open(_pathname, _handle: SubscriptionHandle) {
            return new AbortController().signal;
        },
        async notifyChunk(channel, chunk) {
            // The contract: this is FUSED — append AND emit an event together.
            chunks.push({ channel, chunk });
            notify.streamEvent("sub", channel, "active", chunk.length);
        },
        // close composites the run wake — there is no separate notify.wakeRun;
        // the rich, summary-bearing wake lives where the close context is.
        async close(reason, outcome) { closed = { reason, outcome }; woken += 1; },
    };

    const crossScheme: CrossSchemeCaps = {
        _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape",
    };

    const ctx: SchemeCtx = {
        sessionId: 1, runId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, tags, notify, subscriptions, crossScheme,
    };

    return { ctx, inspect: () => ({ events, chunks, woken, closed }) };
};

test("ctx: entries cap does real CRUD scoped to the store", async () => {
    const { ctx } = makeCtx();
    const data: EntryData = { channels: { body: { content: "hi", mimetype: "text/markdown" } }, tags: ["a"] };
    assert.equal((await ctx.entries.read("known://x")).status, 404);
    const w = await ctx.entries.write("known://x", data);
    assert.equal(w.status, 201);
    assert.equal(w.created, true);
    const r = await ctx.entries.read("known://x");
    assert.equal(r.status, 200);
    assert.equal(r.entry?.channels.body.content, "hi");
    assert.equal((await ctx.entries.delete("known://x")).status, 200);
    assert.equal((await ctx.entries.read("known://x")).status, 404);
});

test("ctx: channels append accumulates (append-only store)", async () => {
    const { ctx } = makeCtx();
    await ctx.entries.write("known://x", { channels: {}, tags: [] });
    await ctx.channels.append("known://x", "body", "foo");
    await ctx.channels.append("known://x", "body", "bar");
    const r = await ctx.entries.read("known://x");
    assert.equal(r.entry?.channels.body.content, "foobar");
});

test("ctx: tags return 404 for absent entries", async () => {
    const { ctx } = makeCtx();
    assert.equal((await ctx.tags.list("known://nope")).status, 404);
});

test("ctx: subscriptions.open returns an awaitable AbortSignal", async () => {
    const { ctx } = makeCtx();
    const handle: SubscriptionHandle = { cancel() {} };
    const signal = await ctx.subscriptions.open("exec://r-1", handle);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
});

test("ctx: notifyChunk is fused — one call appends AND emits an event", async () => {
    const { ctx, inspect } = makeCtx();
    await ctx.subscriptions.notifyChunk("stdout", "line1\n");
    await ctx.subscriptions.notifyChunk("stderr", "warn\n");
    const { chunks, events } = inspect();
    assert.equal(chunks.length, 2);
    // The fusion contract: each notifyChunk produced exactly one stream event.
    assert.equal(events.length, 2);
    assert.match(events[0], /stdout:active:6/);
});

test("ctx: subscriptions.close composites state + wake (stream concluded)", async () => {
    const { ctx, inspect } = makeCtx();
    await ctx.subscriptions.close("done", "exit=0 bytes=42");
    const { closed, woken } = inspect();
    assert.deepEqual(closed, { reason: "done", outcome: "exit=0 bytes=42" });
    assert.equal(woken, 1); // close fires the run wake
});

test("ctx: crossScheme is a deferred placeholder, not an active cap", () => {
    const { ctx } = makeCtx();
    // The only member is the deferral marker — no FROM/TO methods committed.
    assert.deepEqual(Object.keys(ctx.crossScheme), ["_deferred"]);
});

test("ctx: ProposalAware hook applies a resolution and returns a result", async () => {
    const { ctx } = makeCtx();
    // proposals are NOT an injected cap — a scheme implements this hook and
    // the engine calls it on accept. Minimal conformant scheme:
    const scheme: ProposalAware = {
        async applyResolution(pathname, _proposal: ProposalResult, c): Promise<SchemeResult> {
            await c.entries.write(pathname, { channels: { body: { content: "applied", mimetype: "text/markdown" } }, tags: [] });
            return { shape: "entry", status: 200, entryId: 1, channel: "body" };
        },
    };
    const proposal: ProposalResult = { shape: "proposal", status: 202, diff: "@@ +applied @@" };
    const out = await scheme.applyResolution("file://x", proposal, ctx);
    assert.equal(out.status, 200);
    assert.equal((await ctx.entries.read("file://x")).entry?.channels.body.content, "applied");
});
