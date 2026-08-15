import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Digest from "../../src/digest/Digest.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("digest Markdown exposes amplification as exact aggregates while JSON preserves every row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-cardinality-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let workerId = 0;
    let loopId = 0;
    let turnId = 0;
    let openId = 0;
    const readIds: number[] = [];
    try {
        const workspaceId = await insertWorkspace(db, "digest-cardinality");
        workerId = await insertWorker(db, workspaceId);
        loopId = await insertLoop(db, workerId, 1, "amplify");
        turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (
            sequence: number,
            origin: "model" | "plurnk",
            op: "READ" | "EDIT" | "EXEC" | "OPEN",
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
                origin, source: origin === "plurnk" ? "worker://researcher" : null, model_call_id: null,
                op, suffix: "", signal: null,
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
        for (let i = 1; i <= 50; i++) readIds.push(await insert(i, "model", "READ", "/example.test/whale", {}));
        for (let i = 51; i <= 62; i++) await insert(i, "plurnk", "EDIT", `/result${i}.test/`, { kind: "entry_materialized" });
        await insert(63, "model", "READ", "/wiki/Paris", {}, "en.wikipedia.org", "https", "b=2&a=1&a=3", 8443);
        await insert(64, "model", "EXEC", "/filesystem_read_text_file", {
            stream: "atlas:///1/1/64",
        }, null, null);
        await insert(65, "plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(66, "plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(67, "plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", null);
        await insert(68, "plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", "");
        await db.log_set_expanded_by_id.run({ id: readIds[0], expanded: 0 });
        openId = await insert(69, "model", "OPEN", "/**/READ", {
            __plurnk_curation: {
                ids: readIds,
                expanded: 1,
                add: [],
                remove: [],
            },
        }, null, "log");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
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
                expanded_before: number;
                tags_added: string[];
                tags_removed: string[];
            }>;
        };
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/example\.test\/whale ×50 \(seq 1–50\)/);
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/en\.wikipedia\.org:8443\/wiki\/Paris\?b=2&a=1&a=3/);
        assert.equal(
            markdown.match(/\[plurnk\] materialized entry\[200\] https:\/\/result\d+\.test\//g)?.length,
            12,
            "distinct materialization targets remain distinct Markdown evidence",
        );
        assert.doesNotMatch(markdown, /materialized entr(?:y|ies)\[200\] ×12/, "target partitioning replaces the targetless aggregate");
        assert.match(markdown, /\[plurnk\] materialized entry\[200\] https:\/\/repeat\.test:9443\/page\?q=1#body source=worker:\/\/researcher ×2 \(seq 65–66\)/);
        assert.match(markdown, /\[plurnk\] materialized entry\[200\] https:\/\/empty\.test\/ source=worker:\/\/researcher\n/, "an absent query has its own group");
        assert.match(markdown, /\[plurnk\] materialized entry\[200\] https:\/\/empty\.test\/\? source=worker:\/\/researcher\n/, "an explicit empty query has its own group");
        assert.match(markdown, /\[model\] EXEC\[200\] filesystem_read_text_file stream=atlas:\/\/\/1\/1\/64/);
        assert.equal(json.log_entries.length, 69, "machine-readable evidence remains lossless");
        assert.equal(json.log_curation_effects.length, 50, "the suppressed broad OPEN retains every exact selected target");
        assert.deepEqual(json.log_curation_effects[0], {
            operation_log_entry_id: openId,
            target_log_entry_id: readIds[0],
            expanded_before: 0,
            tags_added: [],
            tags_removed: [],
        }, "the digest preserves the target that OPEN actually introduced into context");
        assert.equal(json.log_curation_effects[1]?.expanded_before, 1, "the same event distinguishes an already-open no-op target");
        assert.deepEqual(
            json.log_entries[0],
            {
                id: 1, worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
                origin: "model", source: null, model_call_id: null,
                attrs: {}, op: "READ", target: "https://example.test/whale",
                status_rx: 200, state: "resolved", outcome: null,
            },
            "JSON preserves the row's actor and lifecycle coordinates",
        );
        assert.equal(json.log_entries[50]?.origin, "plurnk", "JSON distinguishes automatic materialization from model actions");
        assert.equal(json.log_entries[50]?.source, "worker://researcher", "JSON preserves the causal worker identity");
        assert.deepEqual(json.log_entries[50]?.attrs, { kind: "entry_materialized" }, "JSON preserves typed machine provenance");
        assert.equal(json.log_entries.find((entry) => entry.target?.includes("wikipedia"))?.target, "https://en.wikipedia.org:8443/wiki/Paris?b=2&a=1&a=3", "JSON preserves authority, port, and serialized query");
        assert.equal(json.log_entries.find((entry) => entry.stream !== undefined)?.stream, "atlas:///1/1/64", "JSON preserves an EXEC's runtime stream identity");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
