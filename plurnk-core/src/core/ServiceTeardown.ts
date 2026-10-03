import StopDeadline from "./StopDeadline.ts";

type Cleanup = readonly [name: string, run: () => Promise<void>];

export default class ServiceTeardown {
    readonly #stopDaemon: (deadline: StopDeadline) => Promise<void>;
    readonly #cleanups: readonly Cleanup[];
    #closing: Promise<void> | null = null;
    #requested = false;

    constructor(stopDaemon: (deadline: StopDeadline) => Promise<void>, ...cleanups: readonly Cleanup[]) {
        this.#stopDaemon = stopDaemon;
        this.#cleanups = cleanups;
    }

    close(): Promise<void> {
        this.#closing ??= this.#close();
        return this.#closing;
    }

    async fail(cause: unknown): Promise<never> {
        try {
            await this.close();
        } catch (cleanupCause) {
            throw new AggregateError(
                [cause, ...ServiceTeardown.#causes(cleanupCause)],
                "service startup and shutdown failed",
            );
        }
        throw cause;
    }

    // The settlement is reported once, to exactly one of the two callbacks: the process ends
    // itself either way ({§crash-only-stop}, #823).
    request(reportFailure: (cause: unknown) => void, onClosed: () => void = () => {}): void {
        if (this.#requested) return;
        this.#requested = true;
        void this.close().then(onClosed, reportFailure);
    }

    static diagnostic(label: string, cause: unknown): string {
        const lines = [`${label}: ${ServiceTeardown.#message(cause)}`];
        if (cause instanceof AggregateError) {
            ServiceTeardown.#causes(cause).forEach((failure, index) => {
                lines.push(`  ${index + 1}. ${ServiceTeardown.#message(failure)}`);
            });
        } else if (cause instanceof Error && cause.cause !== undefined) {
            lines.push(`  cause: ${ServiceTeardown.#message(cause.cause)}`);
        }
        return `${lines.join("\n")}\n`;
    }

    async #close(): Promise<void> {
        const deadline = new StopDeadline();
        const failures: unknown[] = [];
        // Core bounds its own producer/observer sequence. An outer race would let
        // resource release overtake that sequence when the shared deadline expires.
        try {
            await this.#stopDaemon(deadline);
        } catch (cause) {
            failures.push(...ServiceTeardown.#causes(cause));
        }
        for (const [name, cleanup] of this.#cleanups) {
            const result = await deadline.settle(name, cleanup);
            if (result.status === "rejected") failures.push(...ServiceTeardown.#causes(result.reason));
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "service shutdown failed");
    }

    static #causes(cause: unknown): unknown[] {
        return cause instanceof AggregateError
            ? cause.errors.flatMap((failure) => ServiceTeardown.#causes(failure))
            : [cause];
    }

    static #message(cause: unknown): string {
        return cause instanceof Error ? cause.message : String(cause);
    }
}
