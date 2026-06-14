// SPEC §channel-mimetype — cross-mimetype COPY/MOVE → 415. A destination scheme fixes its
// channel mimetypes via its manifest (Known: body=text/markdown); a source
// channel of a different mimetype can't be copied in. Seed a known entry with a
// json body (the seed bypasses write-time markdown enforcement) to get the
// non-markdown source the guard needs.

import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, seedEntryWithChannel } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const copyStmt = (src: UrlPath, dst: UrlPath): CopyStatement => ({
    op: "COPY", suffix: "", signal: null, target: src, lineMarker: null, body: dst.raw, position: { line: 1, column: 1 },
});

test("[§channel-mimetype-cross-mimetype-415] COPY a json-bodied source into a markdown-fixed known:/// dst returns 415", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `copy-415-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "copy mismatch");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // Non-markdown source — the seed sidesteps Known's write-time markdown lock.
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/data/blob", channel: "body", content: "{\"k\":1}", mimetype: "application/json" });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const copy = await engine.dispatch({
            statement: copyStmt(urlPath("known", "/data/blob"), urlPath("known", "/data/copy")),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(copy.status, 415, "json body cannot be copied into a markdown-fixed known channel");
        assert.match((copy as { error?: string }).error ?? "", /mimetype mismatch/);
    } finally { await db.close(); }
});
