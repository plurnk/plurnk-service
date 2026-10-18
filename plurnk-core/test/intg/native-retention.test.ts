import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import NativeContent from "../../src/core/NativeContent.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Retention, { retentionPolicy } from "../../src/server/Retention.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, insertPacketTurn } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { parseDsl } from "./_mock.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { waitForDb } from "./_rpc.ts";
import type { Db } from "../../src/core/Db.ts";
import { namedModelWorker } from "./_workers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const collector = (db: Awaited<ReturnType<typeof openMigrated>>) => new Retention(db, {
    ...retentionPolicy(), autoVacuum: "none", retainPacketMs: -1, retainResponseMs: -1,
    retainPacketTurns: -1, retainResponseTurns: -1,
});

for (const publicationFails of [false, true]) test(`{§native-content-lifetime}: a native READ is protected through ${publicationFails ? "failed" : "successful"} publication`, async (t) => {
    serverProposals(t, "accept");
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "native-read-retention");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Inspect the picture.");
    const turnId = await insertTurn(db, loopId, 1);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, mimetypes: DEFAULT_MIMETYPES });
    assert.equal((await EntryCrud.writeEntry({ authority: "", pathname: "/picture.png" }, {
        channels: { body: { content: "", bytes: PNG, mimetype: "image/png" } },
    }, ctx, "worker")).status, 201);
    const retention = collector(db);
    const retain = NativeContent.retain.bind(NativeContent);
    let hash = "";
    t.mock.method(NativeContent, "retain", async (database: Db, bytes: Uint8Array) => {
        hash = await retain(database, bytes);
        await retention.run();
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "collection cannot race between capture and receipt");
        return hash;
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const dispatch = (source: string, sequence: number) => {
        const [statement] = parseDsl(source);
        assert.ok(statement);
        return engine.dispatch({ workspaceId, workerId, loopId, turnId, statement, sequence, origin: "model" });
    };
    const failure = new Error("fixture receipt write failed");
    if (publicationFails) {
        t.mock.method(db.engine_insert_log_entry, "get", async () => { throw failure; });
        await assert.rejects(dispatch("````READ (worker:///picture.png)\n````", 1), (cause) => cause === failure);
    } else {
        const result = await dispatch("````READ (worker:///picture.png)\n````", 1);
        assert.equal(result.status, 200);
        assert.equal(result.nativeContentHash, hash);
        assert.equal((await dispatch("````KILL (log:///1/1/1/READ)\n````", 2)).status, 200);
        assert.equal((await dispatch("````KILL (worker:///picture.png)\n````", 3)).status, 200);
    }
    assert.notEqual(hash, "", "the real READ path captured native bytes");
    await retention.run();
    if (publicationFails) {
        await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
    } else {
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "curation and source deletion preserve receipt evidence");
        await db.test_delete_worker.run({ id: workerId });
        await retention.run();
        await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
    }
});

test("{§native-content-lifetime}: a packet alone pins its native snapshot until containing history deletion", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "native-packet-retention");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const hash = await NativeContent.retain(db, PNG);
    await insertPacketTurn(db, loopId, 1, {
        sections: [], attributions: [], weight: 1,
        attachments: [{ contentHash: hash, coordinate: "1/1/1/READ", path: "worker:///picture.png", scheme: "worker",
            pathname: "/picture.png", mimetype: "image/png", kind: "image", weight: 1 }],
    });
    const retention = collector(db);
    await retention.run();
    assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG);
    await db.test_delete_worker.run({ id: workerId });
    await retention.run();
    await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
});

test("{§native-content-lifetime}: disabling content collection retains an unreferenced snapshot", async () => {
    await using db = await openMigrated();
    const hash = await NativeContent.retain(db, PNG);
    const retention = new Retention(db, { ...retentionPolicy(), autoVacuum: "none", collectContents: false });
    await retention.run();
    assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG);
    assert.equal((await collector(db).run()).collectedContents, 1);
    await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
});

test("{§native-content-lifetime}: message admission and attachment-only replies retain bytes after source and log curation", async (t) => {
    serverProposals(t, "accept");
    await using db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { reasoning: null,
        content: '````SEND [200,{"attachments":["worker:///reply.txt"]}]\n````\n\n````KILL (log:///**)\n````' } }] });
    const daemon = new Daemon({ db, provider });
    const retention = collector(db);
    const original = NativeContent.retain.bind(NativeContent);
    const hashes = new Set<string>();
    t.mock.method(NativeContent, "retain", async (database: Db, bytes: Uint8Array) => {
        const hash = await original(database, bytes);
        hashes.add(hash);
        await retention.run();
        assert.deepEqual(Buffer.from(await NativeContent.read(database, hash)), Buffer.from(bytes));
        return hash;
    });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "native-message-retention", projectRoot: null });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const statements = (source: string) => parseDsl(source);
        await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: statements("````EDIT (worker:///reply.txt)\nOriginal answer.\n````") });
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Return the attachment.",
            attachments: [{ name: "input.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([1, 2, 3, 4]) }] });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(started.loopId), (status) => status === 200 || status >= 400), 200);
        const messages = await daemon.readMessages({ workspaceId, workerId, loopId: started.loopId });
        assert.equal(messages.length, 2);
        assert.deepEqual(messages.map(({ attachments }) => attachments.map(({ bytes }) => Buffer.from(bytes))),
            [[Buffer.from([1, 2, 3, 4])], [Buffer.from("Original answer.")]]);
        const input = messages[0].attachments[0].target;
        const results = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextWorkerId: workerId, statements: statements([
            `\`\`\`\`KILL (${input})\n\`\`\`\``,
            "````KILL (worker:///reply.txt)\n````",
        ].join("\n\n")) });
        assert.ok(results.every(({ status }) => status < 400), JSON.stringify(results));
        await retention.run();
        assert.deepEqual(await daemon.readMessages({ workspaceId, workerId, loopId: started.loopId }), messages);
        await daemon.stop();
        await db.test_delete_worker.run({ id: workerId });
        await retention.run();
        for (const hash of hashes) await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
    } finally { await daemon.stop(); }
});
