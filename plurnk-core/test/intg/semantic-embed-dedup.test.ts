// Content-addressed semantic artifacts (#416 / #588): identical derivation inputs
// build once, then every pathname attaches the same graph/FTS/vector projection.

import test from "node:test";
import assert from "node:assert/strict";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntrySemantic from "../../src/schemes/_entry-semantic.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});

const edit = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target: url(pathname), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("identical entries attach one complete semantic artifact and both remain addressable (#416, #588)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `artifact-share-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let embeddedTexts = 0;
        const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
        const mimetypes = {
            process: async (input: { content: string }) => ({ content: input.content, embedding: vector, embeddingModel: "stub@shared" }),
            embedBatch: async (texts: readonly string[]) => {
                embeddedTexts += texts.length;
                return texts.map(() => vector);
            },
            embedderInfo: () => ({ maxTokens: 128, countTokens: (text: string) => text.split(/\s+/u).filter(Boolean).length, model: "stub@shared" }),
        } as unknown as Mimetypes;
        const writeCtx = makeSchemeCtx({ db, workspaceId, workerId });
        const deriveCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });

        const body = "shared semantic artifact";
        await new Worker().edit(edit("a.md", body), writeCtx);
        await new Worker().edit(edit("b.md", body), writeCtx);
        await EntryManifest.maintainDerivations(deriveCtx);

        const rows = await (db.test_entries_with_hash_by_scheme_prefix as PrepMethod).all<{ pathname: string; deep_hash: string }>({
            workspace_id: workspaceId, scheme: "worker", prefix: "/%",
        });
        assert.equal(rows.length, 2);
        assert.equal(rows[0].deep_hash, rows[1].deep_hash, "both pathnames point at the same derivation identity");

        const artifacts = await (db.test_artifact_counts as PrepMethod).get<{ artifacts: number; vectors: number }>({ deep_hash: rows[0].deep_hash });
        assert.deepEqual(artifacts, { artifacts: 1, vectors: 1 }, "one complete artifact owns one vector set");
        assert.equal(embeddedTexts, 1, "the shared content embeds exactly once");

        const ranked = await EntrySemantic.rankSemantic(db, workspaceId, "worker", mimetypes, "shared artifact", { first: 10, last: null });
        assert.deepEqual(ranked.results.map((r) => r.pathname).sort(), ["/a.md", "/b.md"],
            "artifact sharing never collapses the independently addressable entries");
    } finally {
        await db.close();
    }
});
