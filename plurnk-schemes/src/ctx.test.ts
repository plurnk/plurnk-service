// Contract tests for the capability ctx (ctx.ts). This module exports
// INTERFACES only — plurnk-service injects the real db-backed impl. What we
// guard here is that the contract is *satisfiable* and the shapes compose:
// a minimal conformant impl that exercises every namespace, doubling as
// executable documentation of the intended call surface. If a future edit
// breaks an interface shape, this stops compiling (tsc) and the behavioral
// assertions stop passing.

import test from "node:test";
import { buffer } from "node:stream/consumers";
import { strict as assert } from "node:assert";
import type {
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
import {
    PacketSections,
    type EditBatchReceipt,
    type EditBatchResult,
    type PacketSectionDraft,
    type PacketSectionTransformer,
    type RepresentationPreparationResult,
    type SchemeHandler,
} from "./index.ts";
import { schemeCtx } from "../test/scheme-ctx.ts";

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
        result: Parameters<StreamSubscription["close"]>[0];
        summary?: string;
        channelResults?: Parameters<StreamSubscription["close"]>[2];
    } | null = null;
    function failure(code: string, status: number, detail: string): ReturnType<typeof Results.failure>;
    function failure<T extends Readonly<Record<string, unknown>>>(
        code: string,
        status: number,
        detail: string,
        fields: T,
    ): ReturnType<typeof Results.failure> & T;
    function failure(
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
    ) {
        return Results.failure("scheme:test", code, status, detail, fields);
    }

    const entries: EntryCaps = {
        operations: {
            async editBatch() {
                return failure("operation-not-implemented", 501, "EDIT is not implemented.", { entryId: null, channel: null });
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
        async address(pathname) { return `test://owner${pathname}`; },
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
        async binary(_chunks, mimetype) {
            return { bytes: await buffer(_chunks), projectionIdentity: `${mimetype}-projection`, readable: {
                content: "projected bytes",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: `${mimetype}-projection`,
            } };
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

    const notifyChunk: StreamSubscription["notifyChunk"] = async (channel, chunk, mimetype) => {
        // The contract: this is FUSED — append AND emit an event together.
        // Optional mimetype retypes the channel to the per-call content type.
        chunks.push({ channel, chunk, mimetype });
        notify.streamEvent("sub", channel, "active", chunk.length);
    };
    // close composites the session wake: the rich, summary-bearing wake lives
    // where the close context is.
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
            return Object.assign(new AbortController().signal, { notifyChunk, close });
        },
    };

    const ctx = schemeCtx({
        entries, channels, notify, projection, subscriptions,
        interactions: { request: async () => ({ action: "cancel" }) },
    });

    return { ctx, inspect: () => ({ events, chunks, woken, closed }) };
};

test("{§capability-ctx} ctx: entry addresses do not acquire resources", async () => {
    const { ctx } = makeCtx();
    assert.equal(await ctx.entries.address("/x"), "test://owner/x");
    assert.equal((await ctx.entries.read("/x")).status, 404);
});

test("{§capability-ctx} ctx: entries cap does real CRUD scoped to the store", async () => {
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

test("{§capability-ctx} ctx: channels append accumulates (append-only store)", async () => {
    const { ctx } = makeCtx();
    await ctx.entries.write("notes:///x", { channels: {} });
    await ctx.channels.append("notes:///x", "body", "foo");
    await ctx.channels.append("notes:///x", "body", "bar");
    const r = await ctx.entries.read("notes:///x");
    assert.equal(r.entry?.channels.body.content, "foobar");
});

test("{§capability-ctx} ctx: subscriptions.open returns an awaitable AbortSignal", async () => {
    const { ctx } = makeCtx();
    const handle: SubscriptionHandle = { cancel() {} };
    const signal = await ctx.subscriptions.open("/r-1", handle);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
});

test("{§capability-ctx} ctx: the opened subscription is the retainable chunk and settlement capability", async () => {
    const { ctx, inspect } = makeCtx();
    const subscription = await ctx.subscriptions.open("/r-1", { cancel() {} });

    await subscription.notifyChunk("stdout", "detached\n", "text/plain");
    await subscription.close({ status: 200 }, "detached complete");

    assert.deepEqual(inspect().chunks, [{ channel: "stdout", chunk: "detached\n", mimetype: "text/plain" }]);
    assert.deepEqual(inspect().closed, { result: { status: 200 }, summary: "detached complete" });
});

test("{§capability-ctx} ctx: notifyChunk is fused — one call appends AND emits an event", async () => {
    const { ctx, inspect } = makeCtx();
    const subscription = await ctx.subscriptions.open("/r-1", { cancel() {} });
    await subscription.notifyChunk("stdout", "line1\n");
    await subscription.notifyChunk("stderr", "warn\n");
    const { chunks, events } = inspect();
    assert.equal(chunks.length, 2);
    // The fusion contract: each notifyChunk produced exactly one stream event.
    assert.equal(events.length, 2);
    assert.match(events[0], /stdout:active:6/);
});

test("{§capability-ctx} ctx: notifyChunk carries an optional per-call mimetype (channel retype)", async () => {
    const { ctx, inspect } = makeCtx();
    const subscription = await ctx.subscriptions.open("/r-1", { cancel() {} });
    await subscription.notifyChunk("body", "<html>hi</html>", "text/html");
    await subscription.notifyChunk("body", "more"); // omitted → channel keeps its type
    const { chunks } = inspect();
    assert.equal(chunks[0].mimetype, "text/html");
    assert.equal(chunks[1].mimetype, undefined);
});

test("{§capability-ctx} ctx: the subscription's close composites state + wake (stream concluded)", async () => {
    const { ctx, inspect } = makeCtx();
    const subscription = await ctx.subscriptions.open("/r-1", { cancel() {} });
    await subscription.close(
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
    assert.equal(woken, 1); // close fires the session wake
});

test("{§capability-ctx} ctx: ProposalAware hook applies a resolution and returns a result", async () => {
    const { ctx } = makeCtx();
    // proposals are NOT an injected cap — a scheme implements this hook and
    // the engine calls it on accept. Minimal conformant scheme:
    const scheme: ProposalAware = {
        async applyResolution(request, c) {
            assert.deepEqual(request, { attrs: { pathname: "file://x" }, metadata: null, body: "applied" });
            await c.entries.write("file://x", { channels: { body: { content: request.body ?? "", mimetype: "text/markdown" } } });
            return { status: 200, outcome: "applied" };
        },
    };
    const out = await scheme.applyResolution({ attrs: { pathname: "file://x" }, metadata: null, body: "applied" }, ctx);
    assert.equal(out.status, 200);
    assert.equal((await ctx.entries.read("file://x")).entry?.channels.body.content, "applied");
});

const httpLike: SchemeHandler = {
    async prepareRepresentation(_request, _ctx): Promise<RepresentationPreparationResult> {
        return { status: 102 };
    },
    async send(_statement, _ctx) {
        return { status: 200 };
    },
};

// @ts-expect-error Scheme handlers cannot replace core-owned READ projection.
const invalidReadHandler: SchemeHandler = { async read() { return { status: 200 }; } };
void invalidReadHandler;

const editReceipt: EditBatchReceipt = {
    revision: "a".repeat(64),
    unit: "codePoints",
    before: 3,
    after: 4,
    effects: [{
        requested: "<1,2,1,2>",
        source: "<1,2,1,2>",
        result: "<1,2,1,3>",
        removed: 0,
        inserted: 1,
        context: "1:xay",
    }],
};

const editResult: EditBatchResult = {
    status: 200,
    editReceipt,
};

const editable: SchemeHandler = {
    async editBatch() {
        return editResult;
    },
};

const addressable: SchemeHandler = {
    async resolveEntryAddress(target) {
        return target.kind === "url"
            ? { authority: "", pathname: target.pathname }
            : null;
    },
};

test("{§scheme-operation-dispatch} SchemeHandler: preparation cannot replace core-owned READ projection", () => {
    assert.equal(typeof httpLike.prepareRepresentation, "function");
    assert.equal(typeof httpLike.send, "function");
    assert.equal("read" in httpLike, false);
    assert.equal(httpLike.find, undefined);
    assert.equal(httpLike.exec, undefined);
});

test("{§scheme-operation-dispatch} SchemeHandler: editBatch exposes the typed aggregate receipt contract", () => {
    assert.equal(typeof editable.editBatch, "function");
    assert.equal(editResult.editReceipt?.unit, "codePoints");
    assert.ok(editResult.editReceipt !== null && editResult.editReceipt !== undefined);
    assert.ok("effects" in editResult.editReceipt);
    assert.equal(editResult.editReceipt.effects[0]?.requested, "<1,2,1,2>");
});

test("{§scheme-operation-dispatch} SchemeHandler: entry address resolution returns the resource coordinate", () => {
    assert.equal(typeof addressable.resolveEntryAddress, "function");
});

const section = (over: Partial<PacketSectionDraft> = {}): PacketSectionDraft =>
    ({ name: "x", slot: "system", header: null, content: "", ...over });

test("{§network-address} PacketSectionTransformer: a scheme reshapes the section list (add/reorder)", async () => {
    const t: PacketSectionTransformer = {
        transformSections(sections) {
            return [...sections, section({ name: "footer", slot: "user", content: "fin" })];
        },
    };
    const out = await t.transformSections([section({ name: "tools" })]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((s) => s.name), ["tools", "footer"]);
});

test("{§network-address} PacketSectionTransformer: async transform + removal supported", async () => {
    const t: PacketSectionTransformer = {
        async transformSections(sections) {
            return sections.filter((s) => s.slot === "system");
        },
    };
    const out = await t.transformSections([section({ slot: "system" }), section({ name: "u", slot: "user" })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].slot, "system");
});

test("{§network-address} PacketSections: exact valid drafts preserve their list", () => {
    const drafts = [section({ name: "definition" }), section({ name: "prompt", slot: "user" }), section({ name: "authored", slot: "assistant" })];
    assert.equal(PacketSections.assertDrafts(drafts), drafts);
});

test("{§network-address} PacketSections: malformed draft lists fail with their exact location", () => {
    assert.throws(() => PacketSections.assertDrafts(null), /packet section drafts must be an array/);
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "tool", header: null, content: "" }]),
        /packet section drafts\[0\]\.slot must be system, user or assistant/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "user", header: null }]),
        /packet section drafts\[0\] is missing field 'content'/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ ...section(), tokens: 0 }]),
        /packet section drafts\[0\] has unexpected field 'tokens'/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([section(), section()]),
        /packet section drafts has duplicate section name 'x'/,
    );
});
