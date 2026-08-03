type Cleanup = () => Promise<void>;

export default class ServiceTeardown {
    readonly #stopDaemon: Cleanup;
    readonly #closeDatabase: Cleanup;
    #closing: Promise<void> | null = null;
    #requested = false;

    constructor(stopDaemon: Cleanup, closeDatabase: Cleanup) {
        this.#stopDaemon = stopDaemon;
        this.#closeDatabase = closeDatabase;
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

    request(reportFailure: (cause: unknown) => void): void {
        if (this.#requested) return;
        this.#requested = true;
        void this.close().catch(reportFailure);
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
        const failures: unknown[] = [];
        try {
            await this.#stopDaemon();
        } catch (cause) {
            failures.push(...ServiceTeardown.#causes(cause));
        }
        try {
            await this.#closeDatabase();
        } catch (cause) {
            failures.push(...ServiceTeardown.#causes(cause));
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
