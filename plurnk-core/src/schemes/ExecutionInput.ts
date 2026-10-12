import type { ExecInputReceiver } from "@plurnk/plurnk-execs";
import Results, { type SchemeResult } from "../core/results.ts";
import { Knob } from "@plurnk/plurnk-meta";

// {§exec-input} Input belongs to the existing invocation. Its preparation declared whether a receiver
// will register ({§executor-live-input}); the scheduler says whether the execution has a slot; the
// executor registers the receiver once it runs. Those three facts name every state a SEND can meet.
export default class ExecutionInput {
    static configuredTimeout(): number {
        return Knob.integer("PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS", 1);
    }

    readonly #lifetime: AbortSignal;
    readonly #closed = new AbortController();
    readonly #timeoutMs: number;
    readonly #declared: boolean;
    readonly #opened = Promise.withResolvers<void>();
    #started = false;
    #receiver: ExecInputReceiver | null = null;
    #tail: Promise<void> = Promise.resolve();

    constructor(lifetime: AbortSignal, timeoutMs: number, declared: boolean) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
            throw new RangeError("PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS must be a positive safe integer.");
        }
        this.#lifetime = lifetime;
        this.#timeoutMs = timeoutMs;
        this.#declared = declared;
    }

    // The scheduler granted the execution its slot: a declared receiver is now opening.
    started(): void { this.#started = true; }

    // Only a running executor registers, so a registration is also the start.
    register(receiver: ExecInputReceiver): void {
        if (!this.#declared) throw new Error("Execution input receiver registered without the preparation declaring input.");
        if (this.#receiver !== null) throw new Error("Execution input receiver already registered.");
        if (this.#closed.signal.aborted || this.#lifetime.aborted) return;
        this.#started = true;
        this.#receiver = receiver;
        this.#opened.resolve();
    }

    close(): void { this.#closed.abort(); }

    // What a SEND meets before delivery: closed input, an execution launched without input, or one
    // still queued for a slot. A declared receiver that has not opened yet is not unavailable; delivery
    // waits for it ({§exec-input}).
    unavailable(): SchemeResult | null {
        if (this.#closed.signal.aborted || this.#lifetime.aborted) {
            return Results.failure("scheme:exec", "input-closed", 410,
                "Execution input is closed.", {}, { retryable: false });
        }
        if (!this.#declared) {
            return Results.failure("scheme:exec", "input-unavailable", 409,
                "This execution was launched without input.", {}, {
                    recovery: "Launch it with `[{\"stdin\": \"open\"}]` when its runtime takes input, then SEND to that execution.",
                    retryable: false,
                });
        }
        if (!this.#started) {
            return Results.failure("scheme:exec", "input-unavailable", 409,
                "This execution is queued for an execution slot; its input opens when it starts.", {}, {
                    recovery: "SEND again once the execution has started.",
                    retryable: true,
                });
        }
        return null;
    }

    async deliver(body: string, metadata: readonly string[] | null, sender?: AbortSignal): Promise<SchemeResult> {
        const unavailable = this.unavailable();
        if (unavailable !== null) return unavailable;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
        const signal = AbortSignal.any([
            this.#lifetime, this.#closed.signal, timeout.signal,
            ...(sender === undefined ? [] : [sender]),
        ]);
        let started = false;
        const aborted = Promise.withResolvers<SchemeResult>();
        const cancel = (): void => {
            const expired = timeout.signal.aborted;
            const closed = this.#closed.signal.aborted || this.#lifetime.aborted;
            // The execution settling or being torn down before delivery began closes input; a bound
            // expiring or the sender leaving cancels the delivery.
            aborted.resolve(closed && !started && !expired
                ? Results.failure("scheme:exec", "input-closed", 410, "Execution input is closed.", {}, { retryable: false })
                : Results.failure("scheme:exec", expired ? "input-timeout" : "input-cancelled", expired ? 504 : 499,
                    `Input delivery ${expired ? "timed out" : "was cancelled"}${started ? "; delivery may be partial" : " before delivery"}.`,
                    {}, { retryable: false }));
            if (started) this.close();
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const predecessor = this.#tail;
        const work = predecessor.then(async (): Promise<SchemeResult> => {
            if (signal.aborted) return aborted.promise;
            // {§exec-input} — the receiver opens when the executor runs; its residence here counts
            // against the same bound as the delivery, and the execution settling first closes input.
            if (this.#receiver === null) {
                const outcome = await Promise.race([this.#opened.promise.then(() => null), aborted.promise]);
                if (outcome !== null) return outcome;
            }
            const unavailable = this.unavailable();
            if (unavailable !== null) return unavailable;
            started = true;
            try {
                const result = Results.assert(await this.#receiver!({ body, metadata, signal }));
                if (result.status === 202) throw new Error("Input delivery must settle, not propose again.");
                return result;
            } catch (cause) {
                if (signal.aborted) return aborted.promise;
                signal.removeEventListener("abort", cancel);
                this.close();
                console.error("Executor input receiver violated its result contract:", cause);
                return Results.failure("scheme:exec", "input-receiver-failed", 500,
                    "Input receiver failed outside its result contract; delivery may be partial.", {}, { retryable: false });
            }
        });
        const result = Promise.race([work, aborted.promise]);
        this.#tail = Promise.all([predecessor, result]).then(() => {});
        try { return await result; }
        finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
        }
    }
}
