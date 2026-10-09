import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { editStmt, noteStmt, urlPath } from "./_dsl.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_db.ts";

test("{§digest-forensic-fidelity}: original failures, ambient observations and forked history retain their provenance", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-provenance-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let parent = 0;
    let child = 0;
    let branch = 0;
    try {
        const workspaceId = await insertWorkspace(db, "digest-provenance");
        parent = await insertWorker(db, workspaceId, null, "parent");
        child = await insertWorker(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1, "inspect");
        const childLoop = await insertLoop(db, child, 1, "inspect");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const response = (ops: ReturnType<typeof noteStmt | typeof editStmt>[]) => ({ assistant: { content: "", reasoning: null, ops } });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response([editStmt(urlPath("missing", "/parent"), "parent action")]),
            response([editStmt(urlPath("missing", "/child"), "child action")]),
            response([noteStmt("observed")]),
        ] });
        const messages = [{ role: "user" as const, content: "inspect" }];
        await engine.runTurn({ provider, workspaceId, workerId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: child, loopId: childLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: parent, loopId: parentLoop, messages, turnNumber: 2 });
        branch = await Fork.fork(db, parent, "branch");
    } finally { await db.close(); }

    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const { log_entries: entries } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        log_entries: Array<{ worker_id: number; origin: string; target: string; status_rx: number; inherited_history: boolean; ambient_event_id: number | null }>;
    };
    const failures = entries.filter(({ status_rx }) => status_rx >= 400);
    const original = failures.find(({ worker_id, target }) => worker_id === parent && target === "missing:///parent");
    const inherited = failures.find(({ worker_id, target }) => worker_id === branch && target === "missing:///parent");
    const childOriginal = failures.find(({ worker_id, target }) => worker_id === child && target === "missing:///child");
    const observation = failures.find(({ worker_id, target }) => worker_id === parent && target === "missing:///child");
    const inheritedObservation = failures.find(({ worker_id, target }) => worker_id === branch && target === "missing:///child");
    assert.ok(original && inherited && childOriginal && observation && inheritedObservation, "each original failure and its observed/copied forms survive export");
    assert.equal(original.origin, "model");
    assert.equal(original.inherited_history, false);
    assert.equal(original.ambient_event_id, null);
    assert.equal(inherited.origin, "model", "origin alone does not identify new model work");
    assert.equal(inherited.inherited_history, true);
    assert.equal(inherited.ambient_event_id, null);
    assert.equal(childOriginal.inherited_history, false);
    assert.equal(typeof childOriginal.ambient_event_id, "number", "a published action retains its occurrence identity too");
    assert.equal(observation.origin, "_plurnk");
    assert.equal(observation.inherited_history, false);
    assert.equal(typeof observation.ambient_event_id, "number");
    assert.equal(observation.ambient_event_id, childOriginal.ambient_event_id, "the observation names the actual originating event");
    assert.equal(inheritedObservation.inherited_history, true);
    assert.equal(inheritedObservation.ambient_event_id, observation.ambient_event_id, "copying an observation preserves the original occurrence identity");
});

test("digest Markdown exposes amplification as exact aggregates while JSON preserves every row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-cardinality-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let workerId = 0;
    let loopId = 0;
    let turnId = 0;
    let killId = 0;
    const readIds: number[] = [];
    try {
        const workspaceId = await insertWorkspace(db, "digest-cardinality");
        workerId = await insertWorker(db, workspaceId);
        loopId = await insertLoop(db, workerId, 1, "amplify");
        turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (
            sequence: number,
            origin: "model" | "_plurnk",
            op: "READ" | "EDIT" | "atlas" | "KILL",
            pathname: string,
            attrs: object,
            hostname: string | null = null,
            scheme: string | null = "https",
            query: string | null = null,
            port: number | null = null,
            fragment: string | null = null,
        ): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: origin === "_plurnk" ? "worker://researcher" : null, model_call_id: null,
                op,
                scheme, username: null, password: null, hostname, port,
                pathname, query, fragment, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content: "x" }), mimetype_rx: "application/json",
                status_rx: 200, weight: 1, state: "resolved", outcome: null,
                attrs: JSON.stringify(attrs),
            });
            if (row === undefined) throw new Error("digest log fixture insert returned no row");
            return row.id;
        };
        for (let i = 1; i <= 50; i++) readIds.push(await insert(i, "model", "READ", "/whale", {}, "example.test"));
        for (let i = 51; i <= 62; i++) await insert(i, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, `result${i}.test`);
        await insert(63, "model", "READ", "/wiki/Paris", {}, "en.wikipedia.org", "https", "b=2&a=1&a=3", 8443);
        await insert(64, "model", "atlas", "/filesystem_read_text_file", {
            stream: "atlas:///1/1/64/atlas",
        }, null, null);
        await insert(65, "_plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(66, "_plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(67, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", null);
        await insert(68, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", "");
        killId = await insert(69, "model", "KILL", "/**/READ", {
            __plurnk_curation: {
                targets: readIds.map((id) => ({
                    id,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[1, -1]],
                })),
                add: [],
                remove: [],
            },
        }, null, "log");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{
                worker_id: number; loop_id: number; turn_id: number;
                origin: string; source: string | null; attrs: unknown;
                target: string | null; stream?: string;
            }>;
            log_curation_effects: Array<{
                operation_log_entry_id: number;
                target_log_entry_id: number;
                active_before: boolean;
                active_after: boolean;
                folded_before: Array<[number, number]>;
                folded_after: Array<[number, number]>;
            }>;
        };
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/example\.test\/whale ×50 \(seq 1–50\)/);
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/en\.wikipedia\.org:8443\/wiki\/Paris\?b=2&a=1&a=3/);
        assert.equal(
            markdown.match(/\[_plurnk\] materialized entry\[200\] https:\/\/result\d+\.test\//g)?.length,
            12,
            "distinct materialization targets remain distinct Markdown evidence",
        );
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/repeat\.test:9443\/page\?q=1#body source=worker:\/\/researcher ×2 \(seq 65–66\)/);
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/empty\.test\/ source=worker:\/\/researcher\n/, "an absent query has its own group");
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/empty\.test\/\? source=worker:\/\/researcher\n/, "an explicit empty query has its own group");
        assert.match(markdown, /\[model\] atlas\[200\] filesystem_read_text_file stream=atlas:\/\/\/1\/1\/64/);
        assert.equal(json.log_entries.length, 69, "machine-readable evidence remains lossless");
        assert.equal(json.log_curation_effects.length, 50, "the suppressed broad scoped KILL retains every exact selected target");
        assert.deepEqual(json.log_curation_effects[0], {
            operation_log_entry_id: killId,
            target_log_entry_id: readIds[0],
            active_before: true,
            active_after: true,
            folded_before: [],
            folded_after: [[1, -1]],
        }, "the digest preserves the target the scoped KILL actually suppressed");
        assert.deepEqual(json.log_curation_effects[1]?.folded_before, [], "every selected target records its exact prior visibility");
        assert.deepEqual(
            json.log_entries[0],
            {
                id: 1, worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
                origin: "model", source: null, model_call_id: null,
                inherited_history: false, ambient_event_id: null,
                attrs: {}, op: "READ", target: "https://example.test/whale",
                status_rx: 200, state: "resolved", outcome: null,
                initial_folded: [], projection: { active: true, folded: [[1, -1]] },
            },
            "JSON preserves the row's actor and lifecycle coordinates",
        );
        assert.equal(json.log_entries[50]?.origin, "_plurnk", "JSON distinguishes automatic materialization from model actions");
        assert.equal(json.log_entries[50]?.source, "worker://researcher", "JSON preserves the causal worker identity");
        assert.deepEqual(json.log_entries[50]?.attrs, { kind: "entry_materialized" }, "JSON preserves typed machine provenance");
        assert.equal(json.log_entries.find((entry) => entry.target?.includes("wikipedia"))?.target, "https://en.wikipedia.org:8443/wiki/Paris?b=2&a=1&a=3", "JSON preserves authority, port, and serialized query");
        assert.equal(json.log_entries.find((entry) => entry.stream !== undefined)?.stream, "atlas:///1/1/64/atlas", "JSON preserves an the execution's runtime stream identity");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
