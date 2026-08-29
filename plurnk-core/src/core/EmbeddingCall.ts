import type {
    EmbedDocumentsOptions,
    EmbedDocumentsResult,
    EmbedQueryOptions,
    EmbedQueryResult,
    EmbeddingCallMetadata,
    Mimetypes,
} from "@plurnk/plurnk-mimetypes";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import InferenceCall, {
    InferenceCallPersistenceError,
    ProviderAccountingIntegrityError,
} from "./InferenceCall.ts";

export type EmbeddingCallKind = "embedding_query" | "embedding_documents";

type InferenceContext = {
    readonly workspaceId: number;
    readonly turnId: number | null;
};

const failureEvidence = (cause: unknown): Record<string, unknown> => cause instanceof Error
    ? {
        name: cause.name,
        message: cause.message,
        ...(cause.cause === undefined ? {} : { cause: String(cause.cause) }),
    }
    : { name: "Error", message: String(cause) };

const errorAccounting = (cause: unknown): readonly ProviderRequestAccounting[] | null => {
    if (typeof cause !== "object" || cause === null || !("accounting" in cause)) return null;
    const accounting = (cause as { accounting?: unknown }).accounting;
    return Array.isArray(accounting) ? accounting as readonly ProviderRequestAccounting[] : null;
};

const persistenceFailure = (cause: unknown): InferenceCallPersistenceError | null => {
    const seen = new Set<unknown>();
    let current = cause;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        if (current instanceof InferenceCallPersistenceError) return current;
        seen.add(current);
        current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return null;
};

// Core-owned logical embedding inference. The artifact performs vector work;
// this class owns durable lifecycle and cardinal physical request evidence.
export default class EmbeddingCall extends InferenceCall {
    readonly #db: Db;

    private constructor(db: Db, id: number, sequence: number) {
        super(db, id, sequence);
        this.#db = db;
    }

    static async open(
        db: Db,
        input: InferenceContext & {
            kind: EmbeddingCallKind;
            model: string;
            inputCount: number;
        },
    ): Promise<EmbeddingCall> {
        let row: { id: number; sequence: number } | undefined;
        try {
            row = await db.engine_open_embedding_call.get<{ id: number; sequence: number }>({
                workspace_id: input.workspaceId,
                turn_id: input.turnId,
                kind: input.kind,
                model: input.model,
            });
            if (row === undefined) throw new Error("INSERT RETURNING produced no row");
            const prepared = await db.engine_prepare_embedding_call.run({
                id: row.id,
                input_count: input.inputCount,
            });
            if (prepared.changes !== 1) throw new Error(`embedding call ${row.id} was not prepared`);
        } catch (cause) {
            throw new InferenceCallPersistenceError(
                `could not open ${input.kind} inference for workspace ${input.workspaceId}`,
                cause,
            );
        }
        return new EmbeddingCall(db, row.id, row.sequence);
    }

    async observeResponse(
        outputCount: number,
        metadata: EmbeddingCallMetadata,
    ): Promise<void> {
        const { accounting, ...artifactMetadata } = metadata;
        this.assertAccounting(accounting);
        try {
            const result = await this.#db.engine_observe_embedding_call_response.run({
                id: this.id,
                output_count: outputCount,
                metadata: JSON.stringify(artifactMetadata),
            });
            if (result.changes !== 1) {
                throw new Error(`embedding call ${this.id} was not pending`);
            }
        } catch (cause) {
            throw new InferenceCallPersistenceError(
                `could not preserve response for embedding call ${this.id}`,
                cause,
            );
        }
    }

    async fail(cause: unknown): Promise<void> {
        try {
            const result = await this.#db.engine_fail_embedding_call.run({
                id: this.id,
                failure: JSON.stringify(failureEvidence(cause)),
            });
            if (result.changes !== 1) {
                throw new Error(`embedding call ${this.id} was not pending`);
            }
        } catch (persistenceCause) {
            throw new InferenceCallPersistenceError(
                `could not preserve failure for embedding call ${this.id}`,
                persistenceCause,
            );
        }
    }

    static async query(
        db: Db,
        context: InferenceContext,
        mimetypes: Mimetypes,
        model: string,
        text: string,
        options: Omit<EmbedQueryOptions, "observeRequest"> = {},
    ): Promise<EmbedQueryResult> {
        const call = await EmbeddingCall.open(db, {
            ...context,
            kind: "embedding_query",
            model,
            inputCount: 1,
        });
        try {
            const result = await mimetypes.embedQuery(text, {
                ...options,
                observeRequest: call.observeRequest,
            });
            await call.observeResponse(1, result.metadata);
            return result;
        } catch (cause) {
            await call.#closeFailure(cause);
            throw cause;
        }
    }

    static async documents(
        db: Db,
        context: InferenceContext,
        mimetypes: Mimetypes,
        model: string,
        texts: readonly string[],
        options: Omit<EmbedDocumentsOptions, "observeRequest"> = {},
    ): Promise<EmbedDocumentsResult> {
        const call = await EmbeddingCall.open(db, {
            ...context,
            kind: "embedding_documents",
            model,
            inputCount: texts.length,
        });
        try {
            const result = await mimetypes.embedDocuments(texts, {
                ...options,
                observeRequest: call.observeRequest,
            });
            await call.observeResponse(result.vectors.length, result.metadata);
            return result;
        } catch (cause) {
            await call.#closeFailure(cause);
            throw cause;
        }
    }

    async #closeFailure(cause: unknown): Promise<void> {
        // The observer is the durability boundary. If it failed to open or
        // settle a physical row, neither accounting comparison nor a second
        // write may claim that the logical call closed. Restart recovery owns
        // the remaining unknown boundary, exactly as it does for generation.
        if (persistenceFailure(cause) !== null) {
            return;
        }
        const accounting = errorAccounting(cause);
        try {
            this.assertAccounting(accounting ?? []);
        } catch (integrityCause) {
            await this.fail(integrityCause);
            if (integrityCause instanceof ProviderAccountingIntegrityError) throw integrityCause;
            throw new ProviderAccountingIntegrityError(String(integrityCause));
        }
        await this.fail(cause);
    }
}
