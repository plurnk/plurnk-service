import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import type { Notice, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, mimetypesFixture } from "./_helpers.ts";

process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const target: UrlPath = {
    kind: "url", raw: "worker:///interrupted.md", scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: "/interrupted.md", query: null, fragment: null,
};
const statement: ResolvedEditStatement = {
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null,
    body: "an interrupted derivation must never attach", position: { line: 1, column: 1 },
};

test("{§derivation-dedup-parallel} an interrupted artifact remains unattached until retry completes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interrupt-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));

        const abort = new AbortController();
        let failOnce = true;
        const vector = EmbeddingVector.encode([1, 0]);
        const mimetypes = mimetypesFixture({
            process: async (input: { content: string }) => ({ content: input.content, embedding: vector, embeddingModel: "stub@interrupt" }),
            embedderInfo: () => ({ contextWindow: 128, countTokens: (text: string) => text.split(/\s+/u).filter(Boolean).length, model: "stub@interrupt" }),
            embedBatch: async (texts: readonly string[]) => {
                if (failOnce) {
                    failOnce = false;
                    abort.abort();
                    throw new DOMException("interrupted", "AbortError");
                }
                return texts.map(() => vector);
            },
        });

        await assert.rejects(
            SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes, signal: abort.signal })),
            /interrupted/,
        );
        const interrupted = await db.test_derivation_interruption_state.get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.deepEqual(interrupted, { deep_hash: null, building: 1, complete: 0 }, "no partial artifact becomes visible through the entry");

        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const recovered = await db.test_derivation_interruption_state.get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.ok(recovered?.deep_hash);
        assert.deepEqual({ building: recovered?.building, complete: recovered?.complete }, { building: 0, complete: 1 }, "retry completes the same artifact and only then attaches it");
    } finally {
        await db.close();
    }
});

test("an entry-local derivation failure is terminal, explicit, and does not block readiness", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `failed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));

        const inputFailure = Object.assign(new Error("fixture reader rejected malformed input"), {
            name: "MimetypeInputError",
            mimetype: "text/markdown",
        });
        const mimetypes = mimetypesFixture({
            process: async () => { throw inputFailure; },
            embedderInfo: () => ({ contextWindow: 128, countTokens: async () => 1, model: "stub@failure" }),
        });

        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const entry = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/interrupted.md" });
        const disposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string }>({ entry_id: entry?.id ?? -1 });
        assert.equal(disposition?.disposition, "failed");
        assert.equal(disposition?.reason, "fixture reader rejected malformed input");
        const state = await db.test_derivation_interruption_state.get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.ok(state?.deep_hash, "the terminal failure attaches an explicit artifact");
        assert.deepEqual({ building: state?.building, complete: state?.complete }, { building: 0, complete: 1 });
    } finally {
        await db.close();
    }
});

test("an internal projection defect propagates and leaves the artifact retryable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `projection-defect-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));

        const failure = new Error("fixture projection implementation failed");
        const mimetypes = mimetypesFixture({
            process: async () => { throw failure; },
            embedderInfo: () => ({ contextWindow: 128, countTokens: async () => 1, model: "stub@failure" }),
        });

        await assert.rejects(
            SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes })),
            (error) => error === failure,
        );
        const state = await db.test_derivation_interruption_state.get<{
            deep_hash: string | null;
            building: number;
            complete: number;
        }>({ workspace_id: workspaceId });
        assert.deepEqual(
            state,
            { deep_hash: null, building: 1, complete: 0 },
            "the internal defect is not reclassified as a terminal bad specimen",
        );
    } finally {
        await db.close();
    }
});

test("successful projection degradations surface once per maintenance pass", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `projection-notice-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));
        await new Worker().edit({
            ...statement,
            target: {
                ...target,
                raw: "worker:///second.md",
                pathname: "/second.md",
            },
            body: "a second source with the same optional grammar degradation",
        }, makeSchemeCtx({ db, workspaceId, workerId }));

        const projectionNotice: Notice = {
            source: "mimetype:text-markdown",
            kind: "grammar_degraded",
            level: "warn",
            message: "fixture grammar is unavailable",
            position: null,
        };
        const mimetypes = mimetypesFixture({
            process: async (input: { content: string }) => ({
                mimetype: "text/markdown",
                ok: true,
                totalLines: 1,
                symbols: [],
                references: [],
                content: input.content,
                notices: [projectionNotice],
            }),
            embedderInfo: async () => null,
        });
        const notices: Notice[] = [];

        await SearchIndex.maintain(makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            mimetypes,
            pushNotice: (notice) => { notices.push(notice); },
        }));

        assert.deepEqual(
            notices.filter(({ kind }) => kind === "grammar_degraded"),
            [projectionNotice],
            "identical successful degradation observations are deduplicated per pass",
        );
        for (const pathname of ["/interrupted.md", "/second.md"]) {
            const entry = await db.test_entries_by_pathname.get<{ id: number }>({ pathname });
            const disposition = await db.test_derivation_disposition.get<{
                disposition: string;
                reason: string;
                deep_hash: string;
            }>({ entry_id: entry?.id ?? -1 });
            assert.equal(disposition?.disposition, "lexical");
            assert.equal(disposition?.reason, "embedder_unavailable");
            assert.ok(disposition?.deep_hash);
        }
    } finally {
        await db.close();
    }
});

test("an index-persistence contract failure propagates and remains retryable instead of becoming a resource failure", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `persistence-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));

        const mimetypes = mimetypesFixture({
            embedderInfo: async () => null,
            process: async (input: { content: string }) => ({
                content: input.content,
                symbols: [],
                references: [{
                    name: "",
                    kind: "use",
                    line: 1,
                    column: 1,
                    endLine: 1,
                    endColumn: 1,
                }],
            }),
        });

        await assert.rejects(
            SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes })),
            /length\(name\) > 0/,
        );
        const state = await db.test_derivation_interruption_state.get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.deepEqual(state, { deep_hash: null, building: 1, complete: 0 },
            "the address remains unattached and the artifact remains retryable");
    } finally {
        await db.close();
    }
});
