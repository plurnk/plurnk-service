// {§provider-failure-normalization} Retry backoff, Retry-After header parsing, and operation deadline backstop (#505, #1313).

import { APICallError, RetryError } from "./errors.ts";

// An AbortSignal is advisory: a wedged transport that never observes it can
// hang the await past the deadline (#505). Once the signal fires, a well-behaved transport unwinds and settles its
// own attempt (and accounting) within a short grace, and that path wins the race untouched; only a
// transport still wedged after the grace is force-rejected with the signal's own reason, so the existing
// operation/cancellation classification is unchanged.
const OPERATION_DEADLINE_UNWIND_GRACE_MS = 1_000;

const headerValue = (headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined => {
    if (headers === undefined) return undefined;
    const target = name.toLowerCase();
    return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
};

const retryDelayMs = (error: APICallError, attempt: number): number => {
    const retryAfterMs = headerValue(error.responseHeaders, "retry-after-ms");
    if (retryAfterMs !== undefined) {
        const timeoutMs = Number.parseFloat(retryAfterMs);
        if (!Number.isNaN(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60_000) return timeoutMs;
    }
    const retryAfter = headerValue(error.responseHeaders, "retry-after");
    if (retryAfter !== undefined) {
        const timeoutSeconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(timeoutSeconds)) return Math.max(0, timeoutSeconds * 1000);
        const parsedDate = Date.parse(retryAfter);
        if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
    }
    return Math.min(1000 * 2 ** (attempt - 1), 10_000);
};

const waitForRetry = (delayMs: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
        reject(signal.reason);
        return;
    }
    const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
    };
    const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
});

export const raceAgainstDeadline = async <T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = Promise.withResolvers<never>();
    const arm = (): void => { timer = setTimeout(() => backstop.reject(signal.reason), OPERATION_DEADLINE_UNWIND_GRACE_MS); };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
    try {
        return await Promise.race([work, backstop.promise]);
    } finally {
        signal.removeEventListener("abort", arm);
        if (timer !== undefined) clearTimeout(timer);
    }
};

export const executeWithRetry = async <T>(
    executeRequest: () => Promise<T>,
    retryAttempts: number,
    operationSignal?: AbortSignal,
): Promise<T> => {
    const errors: unknown[] = [];
    while (true) {
        try {
            return await executeRequest();
        } catch (error) {
            if (operationSignal?.aborted) throw error;
            errors.push(error);
            if (!APICallError.isInstance(error) || !error.isRetryable || retryAttempts === 0) {
                if (errors.length === 1) throw error;
                const message = error instanceof Error ? error.message : String(error);
                throw new RetryError({
                    message: `Failed after ${errors.length} attempts. Last error: ${message}`,
                    reason: "errorNotRetryable",
                    errors,
                });
            }
            if (errors.length > retryAttempts) {
                throw new RetryError({
                    message: `Failed after ${errors.length} attempts. Last error: ${error.message}`,
                    reason: "maxRetriesExceeded",
                    errors,
                });
            }
            await waitForRetry(retryDelayMs(error, errors.length), operationSignal);
        }
    }
};
