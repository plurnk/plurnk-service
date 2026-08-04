// Tests for daemon Phase 4: entry.read and log.read.

import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import SeamSocket from "./_seam.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { rpcProblem } from "./_rpc.ts";
import { Validator, type EntryReadResult } from "@plurnk/plurnk-contracts";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

const rpcCall = (ws: SeamSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

const entryRead = (response: RpcResponse): EntryReadResult =>
    Validator.assertEntryReadResult(response.result as EntryReadResult);

// #364 — the harness rides the seam; the "addr" is the daemon itself.
const withDaemon = async <T>(fn: (db: Db, addr: { daemon: Daemon }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    await daemon.start();
    try { return await fn(db, { daemon }); }
    finally { await daemon.stop(); await db.close(); }
};

const connect = (addr: { daemon: Daemon }): Promise<SeamSocket> => Promise.resolve(new SeamSocket(addr.daemon));

test("entry.read returns the contracts-owned client projection", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "entry-read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///france/capital", content: "Paris", tags: ["france", "europe"] });

            const r = await rpcCall(ws, 3, "entry.read", { target: "worker:///france/capital" });
            const result = entryRead(r);
            assert.equal(result.status, 200);
            assert.ok(result.entry !== null);
            assert.equal(result.entry.target, "worker:///france/capital");
            assert.equal(result.entry.channels.body.content, "Paris");
            assert.equal(result.entry.channels.body.contentOffset, 0);
            assert.equal(result.entry.channels.body.mimetype, "text/markdown");
            assert.deepEqual(result.entry.tags.toSorted(), ["europe", "france"]);
        } finally { ws.close(); }
    });
});

test("entry.read channel+offset returns the incremental slice + full contentLength (#192)", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "entry-read-offset" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///doc", content: "Hello, World", tags: [] });

            // Full read now reports contentLength on every channel (the unit offset uses).
            const full = await rpcCall(ws, 3, "entry.read", { target: "worker:///doc" });
            const fullResult = entryRead(full);
            assert.ok(fullResult.entry !== null);
            const fullCh = fullResult.entry.channels.body;
            assert.equal(fullCh.content, "Hello, World");
            assert.equal(fullCh.contentOffset, 0);
            assert.equal(fullCh.contentLength, 12);

            // Delta read: only the channel, content from the offset, full length back.
            const delta = await rpcCall(ws, 4, "entry.read", { target: "worker:///doc", channel: "body", offset: 7 });
            const deltaResult = entryRead(delta);
            assert.equal(deltaResult.status, 200);
            assert.ok(deltaResult.entry !== null);
            assert.equal(deltaResult.entry.channels.body.content, "World", "content is the slice from the offset");
            assert.equal(deltaResult.entry.channels.body.contentOffset, 7);
            assert.equal(deltaResult.entry.channels.body.contentLength, 12, "contentLength is the full length — the next poll reads from here");
            assert.deepEqual(Object.keys(deltaResult.entry.channels), ["body"], "channel scopes the read to just that channel");

            // offset 0 → whole channel; offset past the end → caught up (empty).
            const whole = await rpcCall(ws, 5, "entry.read", { target: "worker:///doc", channel: "body", offset: 0 });
            const wholeResult = entryRead(whole);
            assert.ok(wholeResult.entry !== null);
            assert.equal(wholeResult.entry.channels.body.content, "Hello, World");
            const past = await rpcCall(ws, 6, "entry.read", { target: "worker:///doc", channel: "body", offset: 100 });
            const pastResult = entryRead(past);
            assert.ok(pastResult.entry !== null);
            assert.equal(pastResult.entry.channels.body.content, "");
            assert.equal(pastResult.entry.channels.body.contentOffset, 12);

            // offset without channel is a contract violation (which channel to slice?).
            const bad = await rpcCall(ws, 7, "entry.read", { target: "worker:///doc", offset: 3 });
            const problem = rpcProblem(bad);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/entry/offset-channel-required");
            assert.equal(problem.offset, 3);
            assert.equal(problem.recovery, "Select the channel to read from the offset.");
        } finally { ws.close(); }
    });
});

test("entry.read returns 404 for missing entry", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "404-test" });
            const r = await rpcCall(ws, 2, "entry.read", { target: "worker:///does-not-exist" });
            const result = entryRead(r);
            assert.equal(result.status, 404);
            assert.equal(result.entry, null);
        } finally { ws.close(); }
    });
});

test("entry.read requires URL-shaped path", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "shape-test" });
            const r = await rpcCall(ws, 2, "entry.read", { target: "not-a-url" });
            const problem = rpcProblem(r);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/entry/target-invalid");
            assert.equal(problem.target, "not-a-url");
            assert.equal(problem.recovery, "Use a scheme://path target.");
        } finally { ws.close(); }
    });
});

test("entry.read with fragment strips fragment (channel selection is per-op concern)", async () => {
    // entry.read returns the WHOLE entry. Channel selection via fragment is for
    // op.read where the model wants a specific channel. entry.read is the
    // omnibus surface — fragment is ignored.
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "fragment-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///x", content: "body content" });
            const r = await rpcCall(ws, 3, "entry.read", { target: "worker:///x#anything" });
            if (r.result === undefined) {
                throw new Error(`entry.read failed: ${JSON.stringify(r)}`);
            }
            const result = entryRead(r);
            assert.equal(result.status, 200);
            assert.ok(result.entry !== null);
            assert.equal(result.entry.target, "worker:///x");
            assert.ok(result.entry.channels.body !== undefined);
        } finally { ws.close(); }
    });
});

test("log.read returns recent entries from the attached workspace", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///a", content: "alpha" });
            await rpcCall(ws, 3, "op.edit", { target: "worker:///b", content: "beta" });

            const r = await rpcCall(ws, 4, "log.read");
            const result = r.result as { status: number; entries: Array<{ op: string; origin: string }> };
            assert.equal(result.status, 200);
            assert.equal(result.entries.length, 2);
            // Order is at DESC — most recent first
            assert.ok(result.entries.every((e) => e.op === "EDIT" && e.origin === "client"));
        } finally { ws.close(); }
    });
});

test("log.read respects limit", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "limit-test" });
            for (let i = 0; i < 5; i++) {
                await rpcCall(ws, 10 + i, "op.edit", { target: `worker:///e${i}`, content: `v${i}` });
            }
            const r = await rpcCall(ws, 20, "log.read", { limit: 3 });
            const result = r.result as { entries: Array<unknown> };
            assert.equal(result.entries.length, 3);
        } finally { ws.close(); }
    });
});

test("log.read filters by sinceId for incremental fetch", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "since-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///a", content: "first" });
            const firstFetch = await rpcCall(ws, 3, "log.read");
            const firstResult = firstFetch.result as { entries: Array<{ id: number }> };
            const lastSeenId = firstResult.entries[0].id;

            await rpcCall(ws, 4, "op.edit", { target: "worker:///b", content: "second" });

            const incremental = await rpcCall(ws, 5, "log.read", { sinceId: lastSeenId });
            const incrementalResult = incremental.result as { entries: Array<{ id: number; tx: { op: string; target: { pathname: string } } }> };
            assert.equal(incrementalResult.entries.length, 1, "only the new entry");
            assert.equal(incrementalResult.entries[0].tx.target.pathname, "/b");
        } finally { ws.close(); }
    });
});

test("log.read entries have hydrated JSON columns", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "hydration-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///x", content: "body", tags: ["a", "b"] });

            const r = await rpcCall(ws, 3, "log.read");
            const result = r.result as { entries: Array<{ tx: unknown; signal: unknown; status_rx: number }> };
            assert.equal(result.entries.length, 1);
            const entry = result.entries[0];
            // tx should be an object (parsed JSON), not a string
            assert.equal(typeof entry.tx, "object");
            // signal should be a parsed array (tags)
            assert.ok(Array.isArray(entry.signal));
            assert.equal(entry.status_rx, 201);
        } finally { ws.close(); }
    });
});

test("log.read by full L/T/S coordinate resolves the single entry's full shape (#271)", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-coord-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///a", content: "alpha" });
            await rpcCall(ws, 3, "op.send", { status: 200, body: "Paris" });

            // Discover the SEND entry's DISPLAY coordinate (no hardcoded ids).
            const all = (await rpcCall(ws, 4, "log.read")).result as { entries: Array<{ id: number; op: string; loop_seq: number; turn_seq: number; sequence: number; tx: unknown }> };
            const send = all.entries.find((e) => e.op === "SEND");
            assert.ok(send, "the SEND entry is in the log");

            // #271 — one call by L/T/S returns exactly that entry, full shape.
            const r = (await rpcCall(ws, 5, "log.read", { loopSeq: send!.loop_seq, turnSeq: send!.turn_seq, sequence: send!.sequence })).result as { status: number; entries: Array<{ id: number; op: string; tx: unknown; rx: unknown }> };
            assert.equal(r.status, 200);
            assert.equal(r.entries.length, 1, "a full coordinate resolves exactly one entry, not a list");
            assert.equal(r.entries[0].id, send!.id, "the coordinate resolves the SEND entry");
            // THE GAP: a SEND's rx is just {status} — the model's message ('Paris') lives in tx,
            // which op.read(log:///L/T/S) (rx-only, for matcher-chaining) can't reach. By coordinate
            // through log.read it now is, server-resolved — no client fetch-all + match.
            assert.match(JSON.stringify(r.entries[0].tx), /Paris/, "the SEND tx body is reachable by coordinate");
        } finally { ws.close(); }
    });
});

test("log.read is workspace-scoped — doesn't see other workspaces' logs", async () => {
    await withDaemon(async (_db, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });

            await rpcCall(wsA, 2, "op.edit", { target: "worker:///a", content: "from A" });
            await rpcCall(wsB, 2, "op.edit", { target: "worker:///b", content: "from B" });

            const rA = await rpcCall(wsA, 3, "log.read");
            const rB = await rpcCall(wsB, 3, "log.read");
            const aEntries = (rA.result as { entries: Array<{ tx: { target: { pathname: string } } }> }).entries;
            const bEntries = (rB.result as { entries: Array<{ tx: { target: { pathname: string } } }> }).entries;

            assert.equal(aEntries.length, 1);
            assert.equal(aEntries[0].tx.target.pathname, "/a");
            assert.equal(bEntries.length, 1);
            assert.equal(bEntries[0].tx.target.pathname, "/b");
        } finally { wsA.close(); wsB.close(); }
    });
});
