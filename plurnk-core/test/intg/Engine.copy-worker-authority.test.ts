import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertOperationTurn, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, copyStmt, moveStmt, readStmt } from "./_dsl.ts";

const address = (name: string, pathname: string, channel: string | null = null) => ({
    ...urlPath("worker", pathname, channel), hostname: name || null,
    raw: `worker://${name}${pathname}${channel === null ? "" : `#${channel}`}`,
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `copy-authority-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "caller");
    const peerId = await insertWorker(db, workspaceId, null, "peer");
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertOperationTurn(db, loopId, 1, "client", 102);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    let sequence = 0;
    const run = (statement: PlurnkStatement) => engine.dispatch({
        statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "client",
    });
    const seed = async (ownerId: number, path = "/source.md", writer: "client" | "_plurnk" = "client") => {
        const result = await new Worker().edit(editStmt(address("~", path), "first\nsecond\nthird"),
            makeSchemeCtx({ db, workspaceId, workerId: ownerId, writer }));
        assert.equal(result.status, 201);
        return result.entryId!;
    };
    return { db, workspaceId, workerId, peerId, run, seed };
};

for (const destination of ["", "~"]) for (const scoped of [false, true]) {
    test(`{§worker-write-scoping}: COPY reads a named worker into '${destination}' with ${scoped ? "scoped" : "whole"} content`, async () => {
        const { db, peerId, run, seed } = await setup();
        try {
            const sourceId = await seed(peerId);
            const statement = copyStmt(address("peer", "/source.md", "body"), address(destination, "/copy.md"));
            const result = await run({ ...statement, source: { ...statement.source,
                lineMarker: scoped ? { marks: [1, 2] } : null,
            } });
            assert.equal(result.status, 201);
            const read = await run(readStmt(address(destination, "/copy.md"), { marks: [1, -1] }));
            assert.equal(read.status, 200);
            assert.equal(typeof read.content, "string");
            assert.match(read.content as string, /first/);
            assert.match(read.content as string, /second/);
            if (scoped) assert.doesNotMatch(read.content as string, /third/);
            else assert.match(read.content as string, /third/);
            assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: sourceId, name: "body" }))?.content,
                "first\nsecond\nthird");
        } finally { await db.close(); }
    });
}

for (const named of ["peer", "caller"]) for (const operation of ["COPY", "MOVE"] as const) {
    test(`{§worker-write-scoping}: ${operation} cannot write through named authority '${named}'`, async () => {
        const { db, workerId, run, seed } = await setup();
        try {
            await seed(workerId);
            const statement = (operation === "COPY" ? copyStmt : moveStmt)(address("~", "/source.md"), address(named, "/blocked.md"));
            const result = await run(statement);
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-space-read-only");
            assert.equal((await run(readStmt(address(named, "/blocked.md")))).status, 404);
            assert.equal((await run(readStmt(address("~", "/source.md")))).status, 200);
        } finally { await db.close(); }
    });
}

for (const named of ["peer", "caller"]) for (const scoped of [false, true]) {
    test(`{§worker-write-scoping}: MOVE preflights ${named} source deletion before ${scoped ? "scoped" : "whole"} destination writes`, async () => {
        const { db, workerId, peerId, run, seed } = await setup();
        try {
            await seed(named === "peer" ? peerId : workerId);
            const statement = moveStmt(address(named, "/source.md"), address("", "/blocked.md"));
            const result = await run({ ...statement, source: { ...statement.source,
                lineMarker: scoped ? { marks: [1, 2] } : null,
            } });
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-space-read-only");
            assert.equal((await run(readStmt(address("", "/blocked.md")))).status, 404);
            assert.equal((await run(readStmt(address(named, "/source.md")))).status, 200);
        } finally { await db.close(); }
    });
}

test("{§worker-generated-subtree}: generated documents remain copyable but not movable or replaceable", async () => {
    const { db, workerId, run, seed } = await setup();
    try {
        await seed(workerId, "/_plurnk/source.md", "_plurnk");
        assert.equal((await run(copyStmt(address("caller", "/_plurnk/source.md"), address("~", "/copy.md")))).status, 201);
        const move = await run(moveStmt(address("~", "/_plurnk/source.md"), address("", "/blocked.md")));
        assert.equal(move.status, 403);
        assert.equal(move.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-generated-read-only");
        assert.equal((await run(readStmt(address("", "/blocked.md")))).status, 404);
        const copy = await run(copyStmt(address("~", "/copy.md"), address("~", "/_plurnk/new.md")));
        assert.equal(copy.status, 403);
        assert.equal(copy.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-generated-read-only");
    } finally { await db.close(); }
});

test("{§worker-read-scope}: names from another workspace remain absent to COPY and MOVE", async () => {
    const { db, run } = await setup();
    try {
        const elsewhere = await insertWorkspace(db, `elsewhere-${crypto.randomUUID()}`);
        await insertWorker(db, elsewhere, null, "elsewhere");
        for (const make of [copyStmt, moveStmt]) {
            const result = await run(make(address("elsewhere", "/source.md"), address("", "/blocked.md")));
            assert.equal(result.status, 404);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-not-found");
            assert.equal((await run(readStmt(address("", "/blocked.md")))).status, 404);
        }
    } finally { await db.close(); }
});
