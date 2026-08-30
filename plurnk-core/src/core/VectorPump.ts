// {§derivation-vectors-background} — an artifact attaches with its graph, FTS, and summary
// while its vectors derive behind it. One pump per workspace owns that backlog: the Engine
// cancels and drains it with the derivation pass, and a semantic query joins it.
import type { Notice } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import EmbeddingCall from "./EmbeddingCall.ts";
import EntrySemantic, { type SemanticPlan } from "../schemes/_entry-semantic.ts";

export type VectorJob = {
    derivationId: number;
    hash: string;
    content: string;
    symbols: readonly { line?: number; endLine?: number }[];
};
// The attached artifact's disposition while it owes vectors: lexical (FTS answers) with this reason.
export const VECTORS_PENDING_REASON = "vectors_pending";

export default class VectorPump {
    readonly #db: Db;
    readonly #workspaceId: number;
    readonly #concurrency: number;
    readonly #heartbeatMs: number;
    readonly #notify: (notice: Notice) => void;
    readonly #abort = new AbortController();
    #plan: SemanticPlan | null = null;
    #queue: VectorJob[] = [];
    readonly #queued = new Set<string>();
    #run: Promise<void> | null = null;
    #completed = 0;
    #total = 0;

    constructor({ db, workspaceId, concurrency, heartbeatMs, notify }: {
        db: Db;
        workspaceId: number;
        concurrency: number;
        heartbeatMs: number;
        notify: (notice: Notice) => void;
    }) {
        this.#db = db;
        this.#workspaceId = workspaceId;
        this.#concurrency = concurrency;
        this.#heartbeatMs = heartbeatMs;
        this.#notify = notify;
    }

    get idle(): boolean {
        return this.#run === null;
    }

    // Resolves once the current backlog landed; rejects with the failure that stopped it.
    drained(): Promise<void> {
        return this.#run ?? Promise.resolve();
    }

    cancel(reason: unknown): void {
        if (!this.#abort.signal.aborted) this.#abort.abort(reason);
    }

    enqueue(plan: SemanticPlan, jobs: readonly VectorJob[]): void {
        this.#abort.signal.throwIfAborted();
        if (plan.info === null) throw new Error("VectorPump.enqueue: the semantic plan has no embedder");
        this.#plan = plan;
        if (this.#run === null) {
            this.#completed = 0;
            this.#total = 0;
        }
        for (const job of jobs) {
            if (this.#queued.has(job.hash)) continue;
            this.#queued.add(job.hash);
            this.#queue.push(job);
            this.#total += 1;
        }
        if (this.#queue.length === 0 || this.#run !== null) return;
        // The registry's copy always holds a handler: a failure reaches its awaiters through
        // drained(), the failed notice, and the rows it left pending — never as an unhandled rejection.
        const run = this.#drain();
        this.#run = run;
        void run.catch(() => {}).finally(() => {
            if (this.#run === run) this.#run = null;
        });
    }

    async #drain(): Promise<void> {
        const heartbeat = setInterval(() => this.#publish("indexing"), this.#heartbeatMs);
        heartbeat.unref();
        try {
            const outcomes = await Promise.allSettled(
                Array.from({ length: Math.min(this.#concurrency, this.#queue.length) }, () => this.#worker()),
            );
            const failures = outcomes
                .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
                .map(({ reason }) => reason);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, `${failures.length} vector workers failed`);
            this.#publish("complete");
        } catch (error) {
            // The rows still say vectors_pending; the next pass re-enqueues them. A cancelled pump
            // reports its cancellation, not the inference failure wrapping it.
            this.#queue = [];
            this.#queued.clear();
            const failure: unknown = this.#abort.signal.aborted ? this.#abort.signal.reason : error;
            this.#publish("failed", failure);
            throw failure;
        } finally {
            clearInterval(heartbeat);
        }
    }

    async #worker(): Promise<void> {
        while (this.#queue.length > 0) {
            this.#abort.signal.throwIfAborted();
            const job = this.#queue.shift()!;
            await this.#land(job);
            this.#queued.delete(job.hash);
            this.#completed += 1;
        }
    }

    async #land({ derivationId, content, symbols }: VectorJob): Promise<void> {
        const plan = this.#plan!;
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(
            plan,
            (texts, options) => EmbeddingCall.documents(
                this.#db,
                { workspaceId: this.#workspaceId, turnId: null },
                plan.mimetypes,
                plan.info!.model,
                texts,
                options,
            ),
            content,
            symbols,
            undefined,
            undefined,
            this.#abort.signal,
        );
        await EntrySemantic.indexEmbedding(this.#db, derivationId, chunks, model);
        await this.#db.derivation_vectors_landed.run({
            derivation_id: derivationId,
            disposition: chunks.length > 0 ? "vector" : "nonsemantic",
            reason: chunks.length > 0 ? null : "no_embedding_content",
        });
    }

    #publish(phase: "indexing" | "complete" | "failed", error?: unknown): void {
        const completed = phase === "complete" ? this.#total : this.#completed;
        const percent = this.#total === 0 ? 100 : Math.floor((completed / this.#total) * 100);
        const message = phase === "indexing"
            ? `Indexing repository vectors: ${percent}% (${completed}/${this.#total})`
            : phase === "complete"
                ? "Repository vectors are ready"
                : `Vector indexing failed: ${error instanceof Error ? error.message : String(error)}`;
        this.#notify({
            source: "engine:derivation",
            kind: "embed_progress",
            phase,
            message,
            completed,
            total: this.#total,
            percent,
            stage: "vectors",
            level: phase === "failed" ? "error" : "info",
        });
    }
}
