// {§methods-rebind} — workspace lifecycle envelopes and transport-local rebinding.

import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import SeamSocket from "./_seam.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { rpcProblem } from "./_rpc.ts";

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

// The integration harness calls the in-process seam. {§rpc}
const withDaemon = async <T>(fn: (db: Db, addr: { daemon: Daemon }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    await daemon.start();
    try { return await fn(db, { daemon }); }
    finally { await daemon.stop(); await db.close(); }
};

const connect = (addr: { daemon: Daemon }): Promise<SeamSocket> => Promise.resolve(new SeamSocket(addr.daemon));

test("{§methods-rebind}: workspace.create returns the selected client's identity", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "workspace.create", { name: "create-shape" });
            const result = r.result as { id: number; name: string; workerId: number; workerName: string };
            assert.equal(typeof result.id, "number");
            assert.equal(result.name, "create-shape");
            assert.equal(typeof result.workerId, "number", "create must surface the worker id (no pending-dance)");
            assert.equal(typeof result.workerName, "string", "create must surface the worker name");
        } finally { ws.close(); }
    });
});

test("{§methods-rebind}: a bound connection switches workspaces without reconnecting", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const a = await rpcCall(ws, 1, "workspace.create", { name: "first" });
            const aId = (a.result as { id: number }).id;
            // Re-create on the SAME connection — previously threw "already attached".
            const b = await rpcCall(ws, 2, "workspace.create", { name: "second" });
            assert.equal(b.error, undefined, "re-create on a bound connection must not throw");
            const bId = (b.result as { id: number }).id;
            assert.notEqual(bId, aId, "the connection switched to a fresh workspace");
            // Re-attach to the first by id — also re-binds cleanly.
            const back = await rpcCall(ws, 3, "workspace.attach", { id: aId });
            assert.equal(back.error, undefined, "re-attach on a bound connection must not throw");
            assert.equal((back.result as { id: number }).id, aId, "switched back to the first workspace");
        } finally { ws.close(); }
    });
});

test("workspace.rename mutates the workspace name; rejects collision + empty (#248)", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "rename-a" });
            const id = (created.result as { id: number }).id;

            // Rename the attached workspace — same id (immutable identity), new handle.
            const renamed = await rpcCall(ws, 2, "workspace.rename", { name: "rename-b" });
            const rr = renamed.result as { id: number; name: string };
            assert.equal(rr.id, id, "same workspace — its mutable name changed, not its identity");
            assert.equal(rr.name, "rename-b", "the workspace name is mutated");

            // The old name is freed — a new workspace can take it (and re-binds this connection).
            const reuse = await rpcCall(ws, 3, "workspace.create", { name: "rename-a" });
            assert.equal(reuse.error, undefined, "the freed name is available again");

            // Collision: rename the (now "rename-a") workspace to a name another workspace holds.
            const collide = await rpcCall(ws, 4, "workspace.rename", { name: "rename-b" });
            const collisionProblem = rpcProblem(collide);
            assert.equal(collisionProblem.type, "https://problems.plurnk.dev/daemon/workspace/name-conflict");
            assert.equal(collisionProblem.name, "rename-b");

            // Empty name is a contract violation.
            const empty = await rpcCall(ws, 5, "workspace.rename", { name: "" });
            const emptyProblem = rpcProblem(empty);
            assert.equal(emptyProblem.type, "https://problems.plurnk.dev/daemon/input/name-invalid");
            assert.equal(emptyProblem.field, "name");

            // Self-rename is a no-op, not a collision.
            const self = await rpcCall(ws, 6, "workspace.rename", { name: "rename-a" });
            assert.equal(self.error, undefined, "renaming to its own name is a no-op, not a collision");
            assert.equal((self.result as { name: string }).name, "rename-a");
        } finally { ws.close(); }
    });
});
