import type { Provider, ProviderResponse, ProviderUsage, ChatMessage, PromptTokenMeasurement } from "./types.ts";
import { ProviderError, type ProviderErrorKind } from "./errors.ts";
import { emitWarningOnce } from "./warnings.ts";
import { assertPromptTokenMeasurement } from "./promptTokens.ts";

// A backend-AVAILABILITY failure: the sub-provider already exhausted its OWN
// transient retries before throwing one of these, so re-hitting the same
// backend is pointless - a sibling may still serve, so the pool overflows to it.
// Auth/quota/content kinds are deliberately absent: a peer backend fails them
// identically, and failing over would only multiply the damage (and the spend).
const OVERFLOW_KINDS: ReadonlySet<ProviderErrorKind> = new Set(["network_failure", "rate_limit"]);

// Pool - fronts N INTERCHANGEABLE backends as one Provider. This is CAPACITY, not
// blend: the mechanism (round-robin across workers, sticky within a worker for
// KV-cache reuse, overflow to a healthy sibling) is public and lives here; the
// blend/escalation DECISION (which SKU, when to switch models) stays the
// consumer's, one level up, by choosing WHICH pool to call. Backends MUST be
// interchangeable - same served model, compatible window - so the pool presents ONE
// honest Provider surface instead of pretending N models are one
// ({§provider-capacity-pool}).
//
// Affinity is the load-bearing part. A worker's turns stick to one backend so its
// stable prompt prefix keeps hitting the same KV cache; scattering a worker across
// backends shreds the prefix cache. It is the same slot-affinity pattern one
// level up: worker -> slot within a llama-server becomes worker -> backend across a
// fleet - round-robin ACROSS workers, sticky WITHIN one.
export default class Pool implements Provider {
    readonly #backends: readonly Provider[];
    readonly #affinity = new Map<string, number>(); // workerId -> backend index; sticky, LRU-bounded
    readonly #cap: number;                            // LRU ceiling on the affinity map
    #next = 0;                                        // round-robin cursor for NEW workers
    readonly #floor: Provider;                        // the min-window backend: the safe budget floor

    // Optional exact tokenizer: present iff every backend exposes one (same
    // vocab, since interchangeable). Delegated; absent when the fleet can't.
    readonly tokenize?: (text: string) => Promise<number[]>;

    constructor(backends: readonly Provider[]) {
        if (backends.length === 0) throw new Error("Pool: at least one backend is required");
        // Homogeneity is a CONTRACT, not a hope: interchangeable backends share a
        // served identity. A heterogeneous "pool" is the consumer's per-turn
        // SELECTION job, not this primitive - fail at construction, never mid-turn.
        const model = backends[0].model;
        const mixed = backends.find((b) => b.model !== model);
        if (mixed !== undefined) throw new Error(`Pool: backends must be interchangeable, got mixed models "${model}" and "${mixed.model}" - heterogeneous blend is the consumer's selection, not a pool`);
        this.#backends = backends;
        this.#cap = backends.length * 8;

        // The exposed window is the SAFE FLOOR across backends (a packet that fits the
        // smallest fits all); its reserves travel with it so the budget stays
        // self-consistent. ANY unknown (null) window makes the pool null - a worker
        // might route to it, and the consumer must not improvise a cap
        // ({§model-fact-resolution}).
        const anyUnknown = backends.find((b) => b.contextWindow === null);
        this.#floor = anyUnknown ?? backends.reduce((lo, b) => (b.contextWindow! < lo.contextWindow! ? b : lo));
        if (new Set(backends.map((b) => b.contextWindow)).size > 1) {
            emitWarningOnce(
                `Pool: backends report different context windows (${backends.map((b) => b.contextWindow).join(", ")}); using the safe floor ${this.#floor.contextWindow}. Interchangeable backends should match.`,
                "PLURNK_POOL_WINDOW_DRIFT",
            );
        }

        // tokenize is a per-instance optional method; expose it iff the whole fleet has it.
        if (backends.every((b) => typeof b.tokenize === "function")) this.tokenize = (text) => this.#backends[0].tokenize!(text);
    }

    // --- Provider surface: interchangeable backends collapse to one honest face ---

    get model(): string { return this.#backends[0].model; }
    get contextWindow(): number | null { return this.#floor.contextWindow; }
    get reasoningReserve(): number | null | undefined { return this.#floor.reasoningReserve; }
    get completionReserve(): number | null | undefined { return this.#floor.completionReserve; }

    // Served id / capabilities aggregate CONSERVATIVELY: a worker could land on any
    // backend, so claim `constrainsOutput` only if EVERY backend does, and
    // `requiresMaxTokens` if ANY does (bring a cap if even one backend needs it).
    get servedModel(): string | undefined {
        const s = this.#backends[0].servedModel;
        return this.#backends.every((b) => b.servedModel === s) ? s : undefined;
    }
    get constrainsOutput(): boolean | undefined {
        return this.#backends.every((b) => b.constrainsOutput === true) ? true : undefined;
    }
    get requiresMaxTokens(): boolean | undefined {
        return this.#backends.some((b) => b.requiresMaxTokens === true) ? true : undefined;
    }

    async countPromptTokens(
        messages: readonly ChatMessage[],
        signal?: AbortSignal,
    ): Promise<PromptTokenMeasurement> {
        const measurements = await Promise.all(this.#backends.map(async (backend) =>
            assertPromptTokenMeasurement(
                await backend.countPromptTokens(messages, signal),
                `Pool backend ${backend.model}`,
            )));
        const tokens = Math.max(...measurements.map((measurement) => measurement.tokens));
        const sources = [...new Set(measurements.map(({ source }) => source))].join(",");
        const estimate = measurements.find((measurement) => measurement.kind === "estimate");
        if (estimate?.kind === "estimate") {
            return {
                kind: "estimate",
                tokens,
                source: `pool:${sources}`,
                detail: `at least one interchangeable backend has only an estimate: ${estimate.detail}`,
            };
        }
        const exact = measurements.every((measurement) => measurement.kind === "exact")
            && measurements.every((measurement) => measurement.tokens === tokens);
        return {
            kind: exact ? "exact" : "upper_bound",
            tokens,
            source: `pool:${sources}`,
        };
    }
    calculateCost(usage: ProviderUsage): number { return this.#backends[0].calculateCost(usage); }

    // --- dispatch ---

    async generate(args: { messages: ChatMessage[]; workerId: string; primaryWorkerId?: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; workspaceId?: string; loop?: number; turn?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse> {
        const { workerId, signal } = args;
        if (workerId === undefined || workerId.length === 0) throw new Error("Pool.generate: workerId is required - affinity keys on it");
        const tried = new Set<number>();
        let idx = this.#route(workerId);
        let lastErr: unknown;
        for (;;) {
            tried.add(idx);
            try {
                return await this.#backends[idx].generate(args);
            } catch (err) {
                lastErr = err;
                if (signal?.aborted) throw err; // caller cancellation is never a failover
                // Only a backend-AVAILABILITY failure overflows; auth/quota/content/
                // malformed fail the same on a peer, so they propagate.
                if (!(err instanceof ProviderError) || !OVERFLOW_KINDS.has(err.kind)) throw err;
                const next = this.#nextUntried(tried);
                if (next === null) throw lastErr; // the whole fleet is unavailable
                this.#affinity.set(workerId, next); // re-stick: the worker's cache moves with it
                idx = next;
            }
        }
    }

    // Route a worker to its affine backend, assigning a fresh one round-robin on
    // first sight. LRU-bounded so a long-lived daemon's map never grows unbounded -
    // an evicted-and-returning worker simply re-pins (one cold prefill, worst case).
    #route(workerId: string): number {
        const pinned = this.#affinity.get(workerId);
        if (pinned !== undefined) {
            this.#affinity.delete(workerId); // refresh LRU recency
            this.#affinity.set(workerId, pinned);
            return pinned;
        }
        const idx = this.#next++ % this.#backends.length;
        if (this.#affinity.size >= this.#cap) this.#affinity.delete(this.#affinity.keys().next().value as string);
        this.#affinity.set(workerId, idx);
        return idx;
    }

    #nextUntried(tried: Set<number>): number | null {
        for (let i = 0; i < this.#backends.length; i++) if (!tried.has(i)) return i;
        return null;
    }
}
