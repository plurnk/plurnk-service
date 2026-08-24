// SPEC {§channel-mimetype} — cross-mimetype COPY/MOVE → 415. A destination scheme fixes its
// channel mimetypes via its manifest (Worker: body=text/markdown); a source
// channel of a different mimetype can't be copied in. Seed a worker entry with a
// json body (the seed bypasses write-time markdown enforcement) to get the
// non-markdown source the guard needs.

import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, seedEntryWithChannel } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const copyStmt = (src: UrlPath, dst: UrlPath): CopyStatement => ({
    op: "COPY", annotation: null, delimiter: "", signal: null, target: src, lineMarker: null,
    body: { target: dst, lineMarker: null }, position: { line: 1, column: 1 },
});

test("COPY a json-bodied source into a markdown-fixed worker:/// dst returns 415", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `copy-415-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "copy mismatch");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // Non-markdown source — the seed sidesteps Worker's write-time markdown lock.
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/data/blob", channel: "body", content: "{\"k\":1}", mimetype: "application/json" });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const copy = await engine.dispatch({
            statement: copyStmt(urlPath("worker", "/data/blob"), urlPath("worker", "/data/copy")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(copy.status, 415, "json body cannot be copied into a markdown-fixed worker channel");
        assert.equal(copy.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
        assert.equal(copy.problem?.channel, "body");
        assert.equal(copy.problem?.sourceMimetype, "application/json");
        assert.equal(copy.problem?.destinationMimetype, "text/markdown");
    } finally { await db.close(); }
});
