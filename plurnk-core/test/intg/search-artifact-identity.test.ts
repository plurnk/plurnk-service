// {§persistent-search-index}: identical derivation inputs build once, then every
// resource attaches the same complete graph/FTS artifact.

import test from "node:test";
import assert from "node:assert/strict";
import type { UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import EntryFts from "../../src/schemes/_entry-fts.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, mimetypesFixture, DEFAULT_MIMETYPES } from "./_helpers.ts";


const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const edit = (pathname: string, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", target: url(pathname), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("identical entries attach one complete search artifact and both remain addressable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `artifact-share-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let processCalls = 0;
        const mimetypes = mimetypesFixture({
            process: async (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                processCalls++;
                return DEFAULT_MIMETYPES.process(...args);
            },
        });
        const writeCtx = makeSchemeCtx({ db, workspaceId, workerId });
        const deriveCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });

        const body = "shared search artifact";
        await new Worker().edit(edit("a.md", body), writeCtx);
        await new Worker().edit(edit("b.md", body), writeCtx);
        await SearchIndex.maintain(deriveCtx);

        const rows = await db.test_entries_with_hash_by_scheme_prefix.all<{ pathname: string; deep_hash: string }>({
            workspace_id: workspaceId, scheme: "worker", prefix: "/%",
        });
        assert.equal(rows.length, 2);
        assert.equal(rows[0].deep_hash, rows[1].deep_hash, "both pathnames point at the same derivation identity");

        const artifacts = await db.test_artifact_counts.get<{ artifacts: number; indexed: number }>({ deep_hash: rows[0].deep_hash });
        assert.deepEqual(artifacts, { artifacts: 1, indexed: 1 }, "one complete artifact owns one full-text record");
        assert.equal(processCalls, 1, "the shared content derives exactly once");

        const ranked = await EntryFts.rankCandidates(
            db,
            rows.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            "shared artifact",
        );
        assert.deepEqual(ranked.matches.map((r) => r.key).sort(), ["/a.md", "/b.md"],
            "artifact sharing never collapses the independently addressable entries");
    } finally {
        await db.close();
    }
});

test("resolved binary classification participates in derivation identity (#93)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `classification-identity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let binary = false;
        let projectionIdentityCalls = 0;
        const mimetypes = mimetypesFixture({
            classify: async () => ({ binary, source: "handler" as const }),
            projectionIdentity: async () => {
                projectionIdentityCalls++;
                return "stable-projection";
            },
            process: async () => ({ symbols: [], references: [] }),
        });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        await new Worker().edit(edit("classified.md", "classification needle"), makeSchemeCtx({ db, workspaceId, workerId }));

        const hash = async (): Promise<string> => {
            const [row] = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string }>({
                workspace_id: workspaceId,
                scheme: "worker",
                prefix: "/classified.md",
            });
            assert.ok(row);
            return row.deep_hash;
        };
        const hits = async (): Promise<string[]> => (await db.test_fts_search.all<{ pathname: string }>({
            workspace_id: workspaceId,
            query: "needle",
        })).map(({ pathname }) => pathname);

        await SearchIndex.maintain(ctx);
        const textHash = await hash();
        assert.deepEqual(await hits(), ["/classified.md"]);
        assert.equal(projectionIdentityCalls, 1);

        binary = true;
        await SearchIndex.maintain(ctx);
        const binaryHash = await hash();
        assert.notEqual(binaryHash, textHash, "changed classification cannot reuse the textual artifact");
        assert.deepEqual(await hits(), [], "binary classification detaches the entry from lexical search");
        assert.equal(projectionIdentityCalls, 1, "binary derivation does not depend on handler output");

        binary = false;
        await SearchIndex.maintain(ctx);
        assert.equal(await hash(), textHash, "the same classification deterministically reuses its prior artifact");
        assert.deepEqual(await hits(), ["/classified.md"]);
        assert.equal(projectionIdentityCalls, 2);
    } finally {
        await db.close();
    }
});

test("mimetype projection identity invalidates derived artifacts without defeating stable reuse (#175)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `projection-identity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let projectionIdentity = "projection-a";
        let symbolName = "Alpha";
        let processCalls = 0;
        const mimetypes = mimetypesFixture({
            projectionIdentity: async () => projectionIdentity,
            process: async () => {
                processCalls++;
                return {
                    symbols: [{ name: symbolName, kind: "function", line: 1, endLine: 1 }],
                    references: [],
                };
            },
        });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        await new Worker().edit(
            edit("projection.md", "one stable readable body"),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );

        const hash = async (): Promise<string> => {
            const [row] = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string }>({
                workspace_id: workspaceId,
                scheme: "worker",
                prefix: "/projection.md",
            });
            assert.ok(row);
            return row.deep_hash;
        };
        const symbols = async (deepHash: string): Promise<string[]> =>
            (await db.test_symbol_names_for_hash.all<{ name: string }>({ deep_hash: deepHash }))
                .map(({ name }) => name);

        await SearchIndex.maintain(ctx);
        const first = await hash();
        assert.deepEqual(await symbols(first), ["Alpha"]);
        assert.equal(processCalls, 1);

        await SearchIndex.maintain(ctx);
        assert.equal(await hash(), first);
        assert.equal(processCalls, 1, "an unchanged projection identity reuses the complete artifact");

        projectionIdentity = "projection-b";
        symbolName = "Beta";
        await SearchIndex.maintain(ctx);
        const revised = await hash();
        assert.notEqual(revised, first);
        assert.deepEqual(await symbols(revised), ["Beta"]);
        assert.equal(processCalls, 2, "changed projection behavior derives one new artifact");

        projectionIdentity = "projection-a";
        symbolName = "Alpha";
        await SearchIndex.maintain(ctx);
        assert.equal(await hash(), first);
        assert.deepEqual(await symbols(first), ["Alpha"]);
        assert.equal(processCalls, 2, "returning to a prior identity reattaches its complete artifact");
    } finally {
        await db.close();
    }
});
