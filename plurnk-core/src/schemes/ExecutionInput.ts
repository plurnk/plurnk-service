import type { ExecInputReceiver } from "@plurnk/plurnk-execs";
import Results, { type SchemeResult } from "../core/results.ts";

// {§exec-input} Input belongs to the existing invocation.
export default class ExecutionInput {
    static configuredTimeout(): number {
        const timeout = Number(process.env.PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS);
        if (!Number.isSafeInteger(timeout) || timeout < 1) {
            throw new RangeError("PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS must be a positive safe integer.");
        }
        return timeout;
    }

    readonly #lifetime: AbortSignal;
    readonly #closed = new AbortController();
    readonly #timeoutMs: number;
    #receiver: ExecInputReceiver | null = null;
    #tail: Promise<void> = Promise.resolve();

    constructor(lifetime: AbortSignal, timeoutMs: number) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
            throw new RangeError("PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS must be a positive safe integer.");
        }
        this.#lifetime = lifetime;
        this.#timeoutMs = timeoutMs;
    }

    register(receiver: ExecInputReceiver): void {
        if (this.#receiver !== null) throw new Error("Execution input receiver already registered.");
        if (this.#closed.signal.aborted || this.#lifetime.aborted) return;
        this.#receiver = receiver;
    }

    close(): void { this.#closed.abort(); }

    unavailable(): SchemeResult | null {
        if (this.#closed.signal.aborted || this.#lifetime.aborted) {
            return Results.failure("scheme:exec", "input-closed", 410,
                "Execution input is closed.", {}, { retryable: false });
        }
        return this.#receiver === null
            ? Results.failure("scheme:exec", "input-unavailable", 409,
                "This execution is not accepting input.", {}, { retryable: false })
            : null;
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
            aborted.resolve(Results.failure("scheme:exec", expired ? "input-timeout" : "input-cancelled", expired ? 504 : 499,
                `Input delivery ${expired ? "timed out" : "was cancelled"}${started ? "; delivery may be partial" : " before delivery"}.`,
                {}, { retryable: false }));
            if (started) this.close();
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const predecessor = this.#tail;
        const work = predecessor.then(async (): Promise<SchemeResult> => {
            if (signal.aborted) return aborted.promise;
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
