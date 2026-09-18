import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import { resourcePaths } from "./_find.ts";
import type { FindResult } from "../../src/schemes/_entry-find.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, logEntries } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";

const frame = PlurnkParser.frame;

test("#713: notes have durable sources, normal log curation, and do not block completion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lifecycle-notes");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Inspect the parser and report the result.");
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reasoning = [frame("NOTE", "The network is not the cause."), frame("EDIT (should-not-exist.txt)", "Never execute reasoning edits.")].join("\n\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: frame("NOTE", "Inspect the parser next."), reasoning } },
            { assistant: { content: frame("KILL (log:///1/2/*/NOTE)", null), reasoning: null } },
            { assistant: { content: frame("SEND", "Finished."), reasoning: frame("NOTE", "Both checks passed.") } },
        ] });
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const notes = logEntries(packet).filter((row) => /^log:\/\/\/1\/2\/\d+\/NOTE$/.test(String(row.logPath)));
        assert.equal(notes.length, 2);
        assert.deepEqual(notes.map((row) => row.resource), ["note://alice/1/2/2", "note://alice/1/2/3"], "each ordinary receipt exposes its recoverable source");
        assert.ok(notes.every((row) => row.origin === undefined || row.origin === "model"));
        const firstSource = await engine.look({ ...context, statement: statement(frame("READ (note://alice/1/2/2) <1,-1>", null)) });
        assert.equal(firstSource.status, 200);
        assert.equal(firstSource.content, "The network is not the cause.");
        const secondSource = await engine.look({ ...context, statement: statement(frame("READ (note://alice/1/2/3) <1,-1>", null)) });
        assert.equal(secondSource.content, "Inspect the parser next.");
        const final = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(final.status, 200, "an extracted note is not an unseen external result");
        const finalPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: final.turnId }))!.packet);
        assert.equal(logEntries(finalPacket).filter((row) => /^log:\/\/\/1\/2\/\d+\/NOTE$/.test(String(row.logPath))).length, 0);
        const sourceAgain = await engine.look({ ...context, statement: statement(frame("READ (note://alice/1/2/2) <1,-1>", null)) });
        assert.equal(sourceAgain.content, "The network is not the cause.", "curating the log does not delete the source note");
        const rawReasoning = await engine.look({ ...context, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
        assert.equal(rawReasoning.content, reasoning);
        const found = await engine.dispatch({ ...context, turnId: final.turnId, sequence: 40, origin: "model",
            statement: statement(frame("FIND (note://alice/1/2/*) /parser/", null)),
        });
        assert.equal(found.status, 200);
        assert.deepEqual(resourcePaths(found as FindResult), ["note://alice/1/2/3"], "source search still works after log curation");
        const fork = await Fork.fork(db, workerId, "branch");
        const inherited = await engine.look({ ...context, workerId: fork, statement: statement(frame("READ (note://branch/1/2/2) <1,-1>", null)) });
        assert.equal(inherited.content, firstSource.content, "FORK preserves source identity and content");
        for (const op of ["EDIT", "KILL"]) {
            const refused = await engine.dispatch({ ...context, turnId: final.turnId, sequence: op === "EDIT" ? 50 : 51, origin: "model",
                statement: statement(frame(`${op} (note://alice/1/2/2)`, op === "EDIT" ? "Changed" : null)),
            });
            assert.equal(refused.status, 403, `${op} cannot change immutable note evidence`);
        }
        const missing = await engine.look({ ...context, statement: statement(frame("READ (note://alice/1/2/99)", null)) });
        assert.equal(missing.status, 404, "an absent note is not an invented empty source");
    } finally { await db.close(); }
});

test("#713: empty WAIT falls through and SEND plus a retrieval observes before concluding", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lifecycle-fallthrough");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: frame("WAIT", "Wait for results."), reasoning: null } },
            { assistant: { content: [frame("SEND", "The answer."), frame("READ (ops://alice/1/1) <1,-1>", null)].join("\n\n"), reasoning: null } },
            { assistant: { content: frame("SEND", null), reasoning: null } },
        ] });
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 200);
    } finally { await db.close(); }
});

test("{§reasoning-notes}: a rejected emission cannot commit its reasoning NOTE", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "rejected-reasoning-note");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const rejectedReasoning = frame("NOTE", "This belongs to the rejected attempt.");
        const acceptedReasoning = frame("NOTE", "This belongs to the accepted attempt.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: [frame("WAIT", "First wait."), frame("WAIT", "Second wait.")].join("\n\n"), reasoning: rejectedReasoning } },
            { assistant: { content: frame("SEND", "Finished."), reasoning: acceptedReasoning } },
        ] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 200);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1]);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        const notes = sources.filter(({ kind }) => kind === "note");
        assert.equal(notes.filter(({ content }) => content === "This belongs to the accepted attempt.").length, 1);
        assert.ok(notes.every(({ content }) => content !== "This belongs to the rejected attempt."));
        const reasoning = await engine.look({ ...context, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
        assert.equal(reasoning.content, acceptedReasoning);
    } finally { await db.close(); }
});
