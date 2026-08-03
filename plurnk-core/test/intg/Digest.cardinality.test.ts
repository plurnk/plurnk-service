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
    try {
        const workspaceId = await insertWorkspace(db, "digest-cardinality");
        workerId = await insertWorker(db, workspaceId);
        loopId = await insertLoop(db, workerId, 1, "amplify");
        turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (
            sequence: number,
            origin: "model" | "plurnk",
            op: "READ" | "EDIT" | "EXEC",
            pathname: string,
            attrs: object,
            hostname: string | null = null,
            scheme: string | null = "https",
            query: string | null = null,
            port: number | null = null,
            fragment: string | null = null,
        ): Promise<void> => {
            await db.engine_insert_log_entry.run({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: null, op, suffix: "", signal: null,
                scheme, username: null, password: null, hostname, port,
                pathname, query, fragment, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content: "x" }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 1, state: "resolved", outcome: null,
                attrs: JSON.stringify(attrs),
            });
        };
        for (let i = 1; i <= 50; i++) await insert(i, "model", "READ", "/example.test/whale", {});
        for (let i = 51; i <= 62; i++) await insert(i, "plurnk", "EDIT", `/result${i}.test/`, { kind: "entry_materialized" });
        await insert(63, "model", "READ", "/wiki/Paris", {}, "en.wikipedia.org", "https", "b=2&a=1&a=3", 8443);
        await insert(64, "model", "EXEC", "/filesystem_read_text_file", {
            stream: "atlas:///1/1/64",
        }, null, null);
        await insert(65, "plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(66, "plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(67, "plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", null);
        await insert(68, "plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", "");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{
                worker_id: number; loop_id: number; turn_id: number;
                origin: string; target: string | null; stream?: string;
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
        assert.match(markdown, /\[plurnk\] materialized entry\[200\] https:\/\/repeat\.test:9443\/page\?q=1#body ×2 \(seq 65–66\)/);
        assert.match(markdown, /\[plurnk\] materialized entry\[200\] https:\/\/empty\.test\/\n/, "an absent query has its own group");
        assert.match(markdown, /\[plurnk\] materialized entry\[200\] https:\/\/empty\.test\/\?\n/, "an explicit empty query has its own group");
        assert.match(markdown, /\[model\] EXEC\[200\] filesystem_read_text_file stream=atlas:\/\/\/1\/1\/64/);
        assert.equal(json.log_entries.length, 68, "machine-readable evidence remains lossless");
        assert.deepEqual(
            json.log_entries[0],
            {
                id: 1, worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
                origin: "model", op: "READ", target: "https://example.test/whale",
                status_rx: 200, state: "resolved", outcome: null,
            },
            "JSON preserves the row's actor and lifecycle coordinates",
        );
        assert.equal(json.log_entries[50]?.origin, "plurnk", "JSON distinguishes automatic materialization from model actions");
        assert.equal(json.log_entries.find((entry) => entry.target?.includes("wikipedia"))?.target, "https://en.wikipedia.org:8443/wiki/Paris?b=2&a=1&a=3", "JSON preserves authority, port, and serialized query");
        assert.equal(json.log_entries.find((entry) => entry.stream !== undefined)?.stream, "atlas:///1/1/64", "JSON preserves an EXEC's runtime stream identity");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
