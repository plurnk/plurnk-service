import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import type {
    Notice,
    ProviderRequestAccounting,
    ProviderRequestObserver,
    UrlPath,
} from "@plurnk/plurnk-contracts";
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
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", signal: null, target, lineMarker: null,
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
            embedderInfo: () => ({
                dimension: 2,
                contextWindow: 128,
                countTokens: (text: string) => text.split(/\s+/u).filter(Boolean).length,
                tokenizerModel: null,
                model: "stub@interrupt",
            }),
            embedDocuments: async (texts: readonly string[]) => {
                if (failOnce) {
                    failOnce = false;
                    abort.abort();
                    throw new DOMException("interrupted", "AbortError");
                }
                return {
                    vectors: texts.map(() => vector),
                    metadata: { inputTokens: null, warnings: [], accounting: [] },
                };
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

test("{§derivation-dedup-parallel} a failed derivation joins every launched sibling before maintenance settles", async () => {
    const priorConcurrency = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
    process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = "2";
    const db = await openMigrated();
    const bothStarted = Promise.withResolvers<void>();
    const releaseSlow = Promise.withResolvers<void>();
    let started = 0;
    let releaseIssued = false;
    try {
        const workspaceId = await insertWorkspace(db, `joined-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        for (const [pathname, body] of [
            ["/fails.md", "this derivation fails after its sibling starts"],
            ["/slow.md", "this derivation completes only after an explicit release"],
        ] as const) {
            await new Worker().edit({
                ...statement,
                target: {
                    ...target,
                    raw: `worker://${pathname}`,
                    pathname,
                },
                body,
            }, makeSchemeCtx({ db, workspaceId, workerId }));
        }

        const model = "fixture/joined-embedding";
        const vector = EmbeddingVector.encode([1, 0]);
        const account = (
            outcome: "response" | "error",
        ): ProviderRequestAccounting => ({
            provider: "fixture",
            model,
            outcome,
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
            cost: { kind: "unknown", reason: "deterministic lifecycle fixture" },
        });
        const settle = async (
            observer: ProviderRequestObserver | undefined,
            accounting: ProviderRequestAccounting,
        ): Promise<void> => {
            assert.ok(observer, "Core observes each physical embedding request");
            const observe = await observer({ provider: accounting.provider, model: accounting.model });
            await observe(accounting);
        };
        const mimetypes = mimetypesFixture({
            process: async (input: { content: string }) => ({
                content: input.content,
                symbols: [],
                references: [],
            }),
            embedderInfo: async () => ({
                dimension: 2,
                contextWindow: 128,
                countTokens: async () => 1,
                tokenizerModel: null,
                model,
            }),
            embedDocuments: async (
                texts: readonly string[],
                { observeRequest }: { observeRequest?: ProviderRequestObserver } = {},
            ) => {
                started++;
                if (started === 2) bothStarted.resolve();
                await bothStarted.promise;
                const failure = texts.some((text) => text.includes("fails"));
                if (!failure) await releaseSlow.promise;
                const accounting = account(failure ? "error" : "response");
                await settle(observeRequest, accounting);
                if (failure) {
                    throw Object.assign(new Error("fixture embedding request failed"), {
                        accounting: [accounting],
                    });
                }
                return {
                    vectors: texts.map(() => vector),
                    metadata: { inputTokens: 1, warnings: [], accounting: [accounting] },
                };
            },
        });

        let state: "pending" | "fulfilled" | "rejected" = "pending";
        let rejection: unknown;
        const maintenance = SearchIndex.maintain(makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            mimetypes,
        })).then(
            () => { state = "fulfilled"; },
            (cause: unknown) => { state = "rejected"; rejection = cause; },
        );
        await bothStarted.promise;
        try {
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(
                state,
                "pending",
                "maintenance retains ownership while any launched derivation remains active",
            );
        } finally {
            releaseIssued = true;
            releaseSlow.resolve();
        }
        await maintenance;
        assert.match(String(rejection), /fixture embedding request failed/u);

        const calls = await db.test_embedding_calls_by_workspace.all<{
            id: number;
            state: string;
        }>({ workspace_id: workspaceId });
        assert.deepEqual(
            calls.map(({ state: callState }) => callState).sort(),
            ["error", "response"],
            "every launched logical call reaches a terminal state",
        );
        for (const call of calls) {
            assert.deepEqual(
                (await db.test_provider_requests_by_inference_call.all<{ state: string }>({
                    inference_call_id: call.id,
                })).map(({ state: requestState }) => requestState),
                ["settled"],
                "every observed physical request is settled before maintenance rejects",
            );
        }
    } finally {
        if (!releaseIssued) releaseSlow.resolve();
        await db.close();
        if (priorConcurrency === undefined) {
            delete process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
        } else {
            process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = priorConcurrency;
        }
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
            embedderInfo: () => ({ dimension: 2, contextWindow: 128, countTokens: async () => 1, tokenizerModel: null, model: "stub@failure" }),
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
            embedderInfo: () => ({ dimension: 2, contextWindow: 128, countTokens: async () => 1, tokenizerModel: null, model: "stub@failure" }),
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
