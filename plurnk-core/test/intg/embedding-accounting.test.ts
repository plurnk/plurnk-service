// {§tokenomics-provider-usage}: embedding inference shares the cardinal
// inference ledger without pretending to be a model emission.

import test from "node:test";
import assert from "node:assert/strict";
import type {
    ProviderRequestAccounting,
    ProviderRequestObserver,
} from "@plurnk/plurnk-contracts";
import {
    EmbeddingVector,
    Mimetypes,
    emptyRegistry,
} from "@plurnk/plurnk-mimetypes";
import EmbeddingCall from "../../src/core/EmbeddingCall.ts";
import ModelCall from "../../src/core/ModelCall.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import {
    insertLoop,
    insertWorker,
    insertWorkspace,
    openMigrated,
} from "./_helpers.ts";

const EMBEDDINGS_PACKAGE = "@plurnk/plurnk-mimetypes-embeddings";
const MODEL = "fixture/embedding-model";

const request = (
    inputTokens: number,
    amount: string,
): ProviderRequestAccounting => ({
    provider: "fixture",
    model: MODEL,
    outcome: "response",
    usage: {
        inputTokens,
        outputTokens: 0,
        totalTokens: inputTokens,
    },
    cost: {
        kind: "charged",
        amount: { amount, currency: "USD" },
        source: "embedding fixture",
    },
});

const mimetypesWith = (embedder: object): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] },
    loader: async (packageName) => {
        if (packageName === EMBEDDINGS_PACKAGE) return embedder;
        throw new Error(`unexpected package ${packageName}`);
    },
});

const localEmbedder = {
    dimension: 1,
    model: MODEL,
    async embedQuery() {
        return {
            vector: EmbeddingVector.encode([1]),
            metadata: { inputTokens: null, warnings: [], accounting: [] },
        };
    },
    async embedDocuments(texts: readonly string[]) {
        return {
            vectors: texts.map(() => EmbeddingVector.encode([1])),
            metadata: { inputTokens: null, warnings: [], accounting: [] },
        };
    },
};

const settleObserved = async (
    observeRequest: ProviderRequestObserver | undefined,
    accounting: ProviderRequestAccounting,
): Promise<void> => {
    assert.ok(observeRequest, "Core supplies the durable observer before hosted inference");
    const settle = await observeRequest({ provider: accounting.provider, model: accounting.model });
    await settle(accounting);
};

test("local embedding is one logical call with no fabricated physical provider request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `embedding-local-${crypto.randomUUID()}`);
        const result = await EmbeddingCall.query(
            db,
            { workspaceId, turnId: null },
            mimetypesWith(localEmbedder),
            MODEL,
            "hello",
        );
        assert.equal(EmbeddingVector.decode(result.vector)[0], 1);

        const calls = await db.test_embedding_calls_by_workspace.all<{
            turn_id: number | null;
            kind: string;
            state: string;
            input_count: number;
            output_count: number;
            metadata: string;
        }>({ workspace_id: workspaceId });
        assert.deepEqual(calls.map(({ turn_id, kind, state, input_count, output_count }) => ({
            turn_id,
            kind,
            state,
            input_count,
            output_count,
        })), [{
            turn_id: null,
            kind: "embedding_query",
            state: "response",
            input_count: 1,
            output_count: 1,
        }]);
        assert.deepEqual(JSON.parse(calls[0]!.metadata), {
            inputTokens: null,
            warnings: [],
        }, "artifact metadata is durable without duplicating the physical ledger");
        assert.equal((await db.test_count_provider_requests.get<{ n: number }>())?.n, 0);
    } finally {
        await db.close();
    }
});

test("inference kind and specialization remain one non-orphanable database identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `embedding-specialization-${crypto.randomUUID()}`);
        const embedding = await EmbeddingCall.open(db, {
            workspaceId,
            turnId: null,
            kind: "embedding_query",
            model: MODEL,
            inputCount: 1,
        });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "specialization");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const generation = await ModelCall.open(db, {
            turnId: turn.id,
            kind: "emission",
            attributions: [],
            model: "fixture/generation-model",
        });

        await assert.rejects(
            db.test_insert_model_call_specialization.run({ id: embedding.id }),
            /must specialize a generation inference/u,
        );
        await assert.rejects(
            db.test_insert_embedding_call_specialization.run({ id: generation.id }),
            /must specialize an embedding inference/u,
        );
        await assert.rejects(
            db.test_delete_embedding_call_specialization.run({ id: embedding.id }),
            /cannot be deleted independently/u,
        );
        await assert.rejects(
            db.test_delete_model_call_specialization.run({ id: generation.id }),
            /cannot be deleted independently/u,
        );
        await assert.rejects(
            db.test_terminalize_inference_call_without_evidence.run({
                id: embedding.id,
                state: "response",
            }),
            /terminal state requires specialization evidence/u,
        );
        assert.equal(
            (await db.test_workspaces_delete.run({ id: workspaceId })).changes,
            1,
            "deleting the parent workspace still cascades through both specializations",
        );
        assert.deepEqual(
            await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }),
            [],
        );
    } finally {
        await db.close();
    }
});

test("hosted partitioning retains issuance order when physical requests settle out of order", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `embedding-hosted-${crypto.randomUUID()}`);
        const accounting = [request(2, "0.002"), request(1, "0.001")];
        const embedder = {
            ...localEmbedder,
            async embedDocuments(
                texts: readonly string[],
                { observeRequest }: { observeRequest?: ProviderRequestObserver } = {},
            ) {
                assert.ok(observeRequest, "Core supplies the durable observer before hosted inference");
                const settleFirst = await observeRequest({
                    provider: accounting[0]!.provider,
                    model: accounting[0]!.model,
                });
                const settleSecond = await observeRequest({
                    provider: accounting[1]!.provider,
                    model: accounting[1]!.model,
                });
                await settleSecond(accounting[1]!);
                await settleFirst(accounting[0]!);
                return {
                    vectors: texts.map(() => EmbeddingVector.encode([1])),
                    metadata: { inputTokens: 3, warnings: [], accounting },
                };
            },
        };
        await EmbeddingCall.documents(
            db,
            { workspaceId, turnId: null },
            mimetypesWith(embedder),
            MODEL,
            ["a", "b", "c"],
        );

        const [call] = await db.test_embedding_calls_by_workspace.all<{
            id: number;
            turn_id: number | null;
            kind: string;
            state: string;
            input_count: number;
            output_count: number;
        }>({ workspace_id: workspaceId });
        assert.deepEqual({
            turnId: call?.turn_id,
            kind: call?.kind,
            state: call?.state,
            input: call?.input_count,
            output: call?.output_count,
        }, {
            turnId: null,
            kind: "embedding_documents",
            state: "response",
            input: 3,
            output: 3,
        });
        const requests = await db.test_provider_requests_by_inference_call.all<{
            sequence: number;
            provider: string;
            model: string;
            state: string;
            outcome: string;
            usage_input: number;
            cost_amount: string;
        }>({ inference_call_id: call!.id });
        assert.deepEqual(requests.map((row) => ({
            sequence: row.sequence,
            provider: row.provider,
            model: row.model,
            state: row.state,
            outcome: row.outcome,
            usage: row.usage_input,
            cost: row.cost_amount,
        })), [
            { sequence: 1, provider: "fixture", model: MODEL, state: "settled", outcome: "response", usage: 2, cost: "0.002" },
            { sequence: 2, provider: "fixture", model: MODEL, state: "settled", outcome: "response", usage: 1, cost: "0.001" },
        ]);
    } finally {
        await db.close();
    }
});

test("turn-attached embedding contributes cost without becoming context occupancy", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `embedding-turn-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "search");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const accounting = [request(4, "0.004")];
        const embedder = {
            ...localEmbedder,
            async embedQuery(
                _text: string,
                { observeRequest }: { observeRequest?: ProviderRequestObserver } = {},
            ) {
                await settleObserved(observeRequest, accounting[0]!);
                return {
                    vector: EmbeddingVector.encode([1]),
                    metadata: { inputTokens: 4, warnings: [], accounting },
                };
            },
        };
        await EmbeddingCall.query(
            db,
            { workspaceId, turnId: turn.id },
            mimetypesWith(embedder),
            MODEL,
            "find this",
        );

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.accounting.costUsd, "0.004");
        assert.equal(usage.accounting.usage?.inputTokens, 4);
        assert.equal(usage.contextTokens, null, "only an emission request describes packet occupancy");
    } finally {
        await db.close();
    }
});

test("Core rejects returned accounting that omits an observed physical request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `embedding-integrity-${crypto.randomUUID()}`);
        const evidence = request(1, "0.001");
        const embedder = {
            ...localEmbedder,
            async embedQuery(
                _text: string,
                { observeRequest }: { observeRequest?: ProviderRequestObserver } = {},
            ) {
                await settleObserved(observeRequest, evidence);
                return {
                    vector: EmbeddingVector.encode([1]),
                    metadata: { inputTokens: 1, warnings: [], accounting: [] },
                };
            },
        };
        await assert.rejects(
            () => EmbeddingCall.query(
                db,
                { workspaceId, turnId: null },
                mimetypesWith(embedder),
                MODEL,
                "mismatch",
            ),
            { name: "ProviderAccountingIntegrityError" },
        );
        const [call] = await db.test_embedding_calls_by_workspace.all<{
            id: number;
            state: string;
            failure: string;
        }>({ workspace_id: workspaceId });
        assert.equal(call?.state, "error");
        assert.match(call?.failure ?? "", /does not match the cardinal requests/u);
        const requests = await db.test_provider_requests_by_inference_call.all<{ state: string }>({
            inference_call_id: call!.id,
        });
        assert.deepEqual(requests.map(({ state }) => state), ["settled"]);
    } finally {
        await db.close();
    }
});

test("a physical-request persistence failure leaves the logical embedding open for recovery", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `embedding-persistence-${crypto.randomUUID()}`);
        const evidence = request(1, "0.001");
        const root = new Error("fixture provider-request settlement storage failed");
        t.mock.method(db.engine_settle_provider_request, "run", async () => { throw root; });
        const embedder = {
            ...localEmbedder,
            async embedQuery(
                _text: string,
                { observeRequest }: { observeRequest?: ProviderRequestObserver } = {},
            ) {
                await settleObserved(observeRequest, evidence);
                return {
                    vector: EmbeddingVector.encode([1]),
                    metadata: { inputTokens: 1, warnings: [], accounting: [evidence] },
                };
            },
        };

        await assert.rejects(
            () => EmbeddingCall.query(
                db,
                { workspaceId, turnId: null },
                mimetypesWith(embedder),
                MODEL,
                "persistence boundary",
            ),
            (cause) => cause instanceof Error
                && cause.name === "InferenceCallPersistenceError"
                && cause.cause === root,
        );
        const [call] = await db.test_embedding_calls_by_workspace.all<{
            id: number;
            state: string;
            failure: string | null;
        }>({ workspace_id: workspaceId });
        assert.equal(call?.state, "pending");
        assert.equal(call?.failure, null);
        assert.deepEqual(
            (await db.test_provider_requests_by_inference_call.all<{ state: string }>({
                inference_call_id: call!.id,
            })).map(({ state }) => state),
            ["pending"],
        );
    } finally {
        await db.close();
    }
});
