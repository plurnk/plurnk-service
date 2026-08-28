// {§semantic-embed-dedup}: identical derivation inputs build once, then every
// resource attaches the same complete graph/FTS/vector artifact.

import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import type { UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import EntrySemantic from "../../src/schemes/_entry-semantic.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, mimetypesFixture } from "./_helpers.ts";

process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const edit = (pathname: string, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", signal: null, target: url(pathname), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("identical entries attach one complete semantic artifact and both remain addressable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `artifact-share-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let embeddedTexts = 0;
        const vector = EmbeddingVector.encode([1, 0]);
        const mimetypes = mimetypesFixture({
            process: async (input: { content: string }) => ({ content: input.content, embedding: vector, embeddingModel: "stub@shared" }),
            embedBatch: async (texts: readonly string[]) => {
                embeddedTexts += texts.length;
                return texts.map(() => vector);
            },
            embedderInfo: () => ({ contextWindow: 128, countTokens: (text: string) => text.split(/\s+/u).filter(Boolean).length, model: "stub@shared" }),
        });
        const writeCtx = makeSchemeCtx({ db, workspaceId, workerId });
        const deriveCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });

        const body = "shared semantic artifact";
        await new Worker().edit(edit("a.md", body), writeCtx);
        await new Worker().edit(edit("b.md", body), writeCtx);
        await SearchIndex.maintain(deriveCtx);

        const rows = await db.test_entries_with_hash_by_scheme_prefix.all<{ pathname: string; deep_hash: string }>({
            workspace_id: workspaceId, scheme: "worker", prefix: "/%",
        });
        assert.equal(rows.length, 2);
        assert.equal(rows[0].deep_hash, rows[1].deep_hash, "both pathnames point at the same derivation identity");

        const artifacts = await db.test_artifact_counts.get<{ artifacts: number; vectors: number }>({ deep_hash: rows[0].deep_hash });
        assert.deepEqual(artifacts, { artifacts: 1, vectors: 1 }, "one complete artifact owns one vector set");
        assert.equal(embeddedTexts, 1, "the shared content embeds exactly once");

        const ranked = await EntrySemantic.rankCandidates(
            db,
            rows.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            mimetypes,
            "shared artifact",
            { threshold: null },
        );
        assert.deepEqual(ranked.results.map((r) => r.key).sort(), ["/a.md", "/b.md"],
            "artifact sharing never collapses the independently addressable entries");
    } finally {
        await db.close();
    }
});

test("fallback tokenizer identity invalidates an otherwise identical semantic derivation (#87)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tokenizer-identity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let tokenizerId = "vocab-a";
        let tokenizerResolutions = 0;
        let embeddedTexts = 0;
        const vector = EmbeddingVector.encode([1, 0]);
        const mimetypes = mimetypesFixture({
            process: async () => ({ symbols: [], references: [] }),
            embedBatch: async (texts: readonly string[]) => {
                embeddedTexts += texts.length;
                return texts.map(() => vector);
            },
            embedderInfo: () => ({
                dimension: 2,
                contextWindow: 128,
                countTokens: null,
                model: "remote:stable@d2",
            }),
            tokenizer: async (modelRef: string) => {
                assert.equal(modelRef, "remote:stable@d2");
                tokenizerResolutions++;
                return {
                    countTokens: async (text: string) => text.split(/\s+/u).filter(Boolean).length,
                    tokenizerId,
                    exact: true,
                };
            },
        });
        const writeCtx = makeSchemeCtx({ db, workspaceId, workerId });
        const deriveCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });

        await new Worker().edit(edit("identity.md", "one stable semantic body"), writeCtx);
        await SearchIndex.maintain(deriveCtx);
        const first = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string }>({
            workspace_id: workspaceId,
            scheme: "worker",
            prefix: "/identity.md",
        });
        assert.equal(first.length, 1);
        assert.equal(embeddedTexts, 1);

        await SearchIndex.maintain(deriveCtx);
        assert.equal(embeddedTexts, 1, "an unchanged vocabulary identity reuses the complete artifact");

        tokenizerId = "vocab-b";
        await SearchIndex.maintain(deriveCtx);
        const changed = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string }>({
            workspace_id: workspaceId,
            scheme: "worker",
            prefix: "/identity.md",
        });
        assert.notEqual(changed[0]?.deep_hash, first[0]?.deep_hash, "the vocabulary change changes derivation identity");
        assert.equal(embeddedTexts, 2, "the changed vocabulary forces one new vector derivation");
        assert.equal(tokenizerResolutions, 3, "one fallback tokenizer resolution is shared by each indexing pass");
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
            embedderInfo: async () => null,
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
            embedderInfo: async () => null,
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

test("an unmatched fallback tokenizer fails semantic maintenance before derivation or embedding (#95)", async () => {
    const db = await openMigrated();
    const previousMaxEmbedSize = process.env.PLURNK_SERVICE_MAX_EMBED_SIZE;
    try {
        const workspaceId = await insertWorkspace(db, `tokenizer-refusal-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        let processCalls = 0;
        let embedCalls = 0;
        const tokenizerNotice = {
            source: "tokenizer",
            kind: "tokenizer_unavailable",
            level: "warn",
            message: "No exact tokenizer for the remote embedding model.",
            position: null,
        } as const;
        const mimetypes = mimetypesFixture({
            process: async () => {
                processCalls++;
                return { symbols: [], references: [] };
            },
            embedBatch: async () => {
                embedCalls++;
                return [];
            },
            embedderInfo: () => ({
                dimension: 2,
                contextWindow: 8,
                countTokens: null,
                model: "remote:unmatched-embedding-model@d2",
            }),
            tokenizer: async () => ({
                countTokens: async (text: string) => Math.ceil(text.length / 2),
                tokenizerId: "heuristic:chars2",
                exact: false,
                notices: [tokenizerNotice],
            }),
        });
        const notices: unknown[] = [];
        const recordNotice = (notice: unknown): void => { notices.push(notice); };

        await new Worker().edit(edit("unicode.json", JSON.stringify({ specimen: "漢字🙂".repeat(8) })), makeSchemeCtx({ db, workspaceId, workerId }));
        await assert.rejects(
            SearchIndex.maintain(makeSchemeCtx({
                db,
                workspaceId,
                workerId,
                mimetypes,
                pushNotice: recordNotice,
            })),
            /exact token counter.*remote:unmatched-embedding-model@d2/i,
        );

        assert.deepEqual(notices, [tokenizerNotice], "the original structured degradation evidence is forwarded once");
        assert.equal(processCalls, 0, "the pass rejects the global capability gap before resource processing");
        assert.equal(embedCalls, 0, "no content reaches the remote embedder");
        const rows = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string | null }>({
            workspace_id: workspaceId,
            scheme: "worker",
            prefix: "/unicode.json",
        });
        assert.equal(rows[0]?.deep_hash, null, "the entry remains unattached");
        assert.deepEqual(
            await db.test_derivation_state_counts.get<{ building: number; complete: number }>({}),
            { building: 0, complete: 0 },
            "preflight refusal leaves no partial derivation artifact",
        );

        process.env.PLURNK_SERVICE_MAX_EMBED_SIZE = "1";
        await SearchIndex.maintain(makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            mimetypes,
            pushNotice: recordNotice,
        }));
        assert.equal(processCalls, 1, "the readable body still receives graph and lexical derivation");
        assert.equal(embedCalls, 0);
        assert.deepEqual(
            notices.filter((notice) => notice.kind === "tokenizer_unavailable"),
            [tokenizerNotice],
            "a deliberately non-vector pass does not repeat the tokenizer refusal",
        );
        const entry = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/unicode.json" });
        const disposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string }>({ entry_id: entry?.id ?? -1 });
        assert.deepEqual(
            { disposition: disposition?.disposition, reason: disposition?.reason },
            { disposition: "lexical", reason: "max_embed_size" },
            "the established operator ceiling remains a successful lexical-only disposition",
        );
    } finally {
        if (previousMaxEmbedSize === undefined) delete process.env.PLURNK_SERVICE_MAX_EMBED_SIZE;
        else process.env.PLURNK_SERVICE_MAX_EMBED_SIZE = previousMaxEmbedSize;
        await db.close();
    }
});
