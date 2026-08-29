// Portable implementation of @plurnk/plurnk-mimetypes' explicit query/document
// embedding seam ({§mimetype-embedding}). Unset PLURNK_EMBEDDING_MODEL uses the
// bundled hermetic MiniLM runtime; a provider/model route resolves through the
// same standard provider boundary as generation.
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import {
    loadRuntime, embedText, releaseRuntime,
    dimension as localDimension, contextWindow as localContextWindow,
} from "./embed-core.js";
import { embedDocumentsWithModel, embedQueryWithModel } from "./standard.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Local document pool size. Each worker
// holds its own model copy. Unset/empty uses every available core while leaving
// one free on hosts larger than four cores; -1 explicitly claims every core,
// and a positive value is an operator-selected resource budget.
const WORKERS = requireWorkers(process.env.PLURNK_EMBEDDING_WORKERS);

function requireWorkers(raw) {
    if (raw === undefined || raw.trim() === "") {
        const cores = availableParallelism();
        return cores <= 4 ? cores : cores - 1;
    }
    const n = Number(raw);
    if (n === -1) return availableParallelism();
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(
            `PLURNK_EMBEDDING_WORKERS must be -1 (match cores) or a positive integer; got ${JSON.stringify(raw)}.`,
        );
    }
    return n;
}

const REPO = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8";
const PIN = readFileSync(path.join(here, ".model-pin"), "utf-8").trim();
export const dimension = localDimension;
export const contextWindow = localContextWindow;
export const tokenizerModel = undefined;
export const model = `${REPO}@${PIN.slice(0, 8)}+${DTYPE}`;
const identity = (value) => value;

let runtimePromise = null;
let disposePromise = null;
function runtime() {
    runtimePromise ??= loadRuntime();
    return runtimePromise;
}

async function embedLocal(text) {
    const bytes = await embedText(await runtime(), text);
    return EmbeddingVector.encode(
        new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT),
        dimension,
        "local embedding",
    );
}

const localEmbeddingModel = (execute) => ({
    specificationVersion: "v4",
    provider: "plurnk-local",
    modelId: model,
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal }) {
        if (values.length !== 1) {
            throw new RangeError(`local embedding model accepts exactly one value per call; got ${values.length}`);
        }
        abortSignal?.throwIfAborted();
        const bytes = await execute(values[0], abortSignal);
        abortSignal?.throwIfAborted();
        return {
            embeddings: [Array.from(EmbeddingVector.decode(bytes, dimension, "local embedding model"))],
            warnings: [],
        };
    },
});

const LOCAL_QUERY_MODEL = localEmbeddingModel(async (text, signal) => {
    signal?.throwIfAborted();
    const vector = await embedLocal(text);
    signal?.throwIfAborted();
    return vector;
});
const LOCAL_DOCUMENT_MODEL = localEmbeddingModel(
    (text, signal) => enqueueWorkerJob("embed", text, signal),
);

// Untruncated token count in the bundled model's own tokenizer (CLS/SEP
// included), scheduled through the same host-adaptive worker pool as batches.
export async function countTokens(text, { signal } = {}) {
    return enqueueWorkerJob("count", text, signal);
}

// A local worker executes one isolated unit: model startup, one exact token
// count, or one at-most-window embedding. Five minutes is a deliberately wide
// internal liveness rail, not an operator throughput target. Cancellation and
// teardown remain immediate and do not wait for this deadline.
const WORKER_OPERATION_TIMEOUT_MS = 300_000;
const WORKER_RELEASE_TIMEOUT_MS = 30_000;

let poolState = null;
function pool() {
    if (poolState !== null) return poolState;
    const state = {
        url: new URL("./embed-worker.js", import.meta.url),
        workers: [],
        owned: new Set(),
        queue: [],
        active: new Map(),
        handlers: new Map(),
        disposable: new Set(),
        starting: new Set(),
        startupCancels: new Map(),
        terminations: new Map(),
        closing: false,
        failure: null,
        initializationFailure: null,
        closeReason: new Error("embed worker pool closing"),
    };
    poolState = state;
    const starts = Array.from({ length: WORKERS }, () => trackWorkerStart(state));
    void initializePool(state, starts);
    return state;
}

async function initializePool(state, starts) {
    try {
        await Promise.all(starts);
        dispatchPool(state);
        return;
    } catch (cause) {
        if (state.closing) return;
        state.closing = true;
        cancelWorkerStarts(state);
        const terminationErrors = await terminateWorkers(state, [...state.owned]);
        const startErrors = rejectedReasons(await Promise.allSettled(starts))
            .filter((error) => error !== cause && error !== state.closeReason);
        const errors = uniqueErrors([cause, ...startErrors, ...terminationErrors]);
        state.initializationFailure = errors.length > 1
            ? new AggregateError(errors, "embed worker pool startup cleanup failed")
            : cause;
        rejectQueued(state, state.initializationFailure);
    }
}

async function startPoolWorker(state) {
    // Don't inherit parent entry-point flags (--eval, --input-type, --test,
    // --watch); they do not apply to this file-based worker.
    const worker = new Worker(state.url, { execArgv: [] });
    state.owned.add(worker);
    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            let deadline;
            let cancel;
            const cleanup = () => {
                clearTimeout(deadline);
                worker.off("message", ready);
                worker.off("error", failed);
                worker.off("exit", exited);
                if (state.startupCancels.get(worker) === cancel) state.startupCancels.delete(worker);
            };
            const settle = (action) => {
                if (settled) return;
                settled = true;
                cleanup();
                action();
            };
            const ready = (message) => settle(() => {
                if (state.closing) reject(state.closeReason);
                else if (message?.ready === true) {
                    if (message.dispose === true) state.disposable.add(worker);
                    resolve();
                }
                else reject(new Error(`embed worker failed to load: ${message?.error ?? "unknown"}`));
            });
            const failed = (error) => settle(() => reject(asError(error, "embed worker startup failed")));
            const exited = (code) => settle(() => reject(
                state.closing ? state.closeReason : workerExitError(code, " during startup"),
            ));
            worker.on("message", ready);
            worker.on("error", failed);
            worker.on("exit", exited);
            cancel = () => settle(() => reject(state.closeReason));
            state.startupCancels.set(worker, cancel);
            deadline = setTimeout(
                () => settle(() => reject(workerTimeoutError("startup"))),
                WORKER_OPERATION_TIMEOUT_MS,
            );
            deadline.unref?.();
        });
    } catch (cause) {
        const errors = await terminateWorkers(state, [worker]);
        if (errors.length > 0) {
            throw new AggregateError([cause, ...errors], "embed worker startup cleanup failed");
        }
        throw cause;
    }
    activateWorker(state, worker);
    return worker;
}

function cancelWorkerStarts(state) {
    for (const cancel of [...state.startupCancels.values()]) cancel();
}

function trackWorkerStart(state) {
    const started = startPoolWorker(state);
    state.starting.add(started);
    void started.then(
        () => state.starting.delete(started),
        () => state.starting.delete(started),
    );
    return started;
}

function restorePoolCapacity(state) {
    if (state.closing || state.failure !== null || state.initializationFailure !== null) return;
    const missing = WORKERS - state.workers.length - state.starting.size;
    for (let index = 0; index < missing; index += 1) {
        const started = trackWorkerStart(state);
        void started.then(
            () => {
                dispatchPool(state);
                restorePoolCapacity(state);
            },
            (error) => {
                if (!state.closing && state.workers.length === 0 && state.starting.size === 0) {
                    rejectQueued(state, error);
                }
            },
        );
    }
}

function activateWorker(state, worker) {
    const message = (value) => workerMessage(state, worker, value);
    const error = (cause) => retireWorker(
        state,
        worker,
        asError(cause, "embed worker failed"),
        true,
    );
    const exit = (code) => retireWorker(state, worker, workerExitError(code), false);
    state.handlers.set(worker, { message, error, exit });
    state.workers.push(worker);
    worker.on("message", message);
    worker.on("error", error);
    worker.on("exit", exit);
    worker.unref();
}

function workerMessage(state, worker, message) {
    const job = state.active.get(worker);
    if (job === undefined) {
        retireWorker(
            state,
            worker,
            new Error("embed worker returned a result without an active job"),
            true,
        );
        return;
    }
    if (message !== null && typeof message === "object" && "error" in message) {
        state.active.delete(worker);
        worker.unref();
        settleJob(job, "reject", new Error(message.error ?? "embed worker operation failed"));
        dispatchPool(state);
        return;
    }
    let value;
    try {
        if (job.kind === "count") {
            if (!Number.isSafeInteger(message?.count) || message.count < 0) {
                throw new TypeError(`expected a non-negative safe-integer count, got ${JSON.stringify(message?.count)}`);
            }
            value = message.count;
        } else {
            if (!(message?.buffer instanceof ArrayBuffer)) {
                throw new TypeError("expected an ArrayBuffer embedding result");
            }
            value = EmbeddingVector.encode(
                new Float32Array(message.buffer),
                dimension,
                "local batch embedding",
            );
        }
    } catch (cause) {
        retireWorker(
            state,
            worker,
            new Error("embed worker returned an invalid result", { cause }),
            true,
        );
        return;
    }
    state.active.delete(worker);
    worker.unref();
    settleJob(job, "resolve", value);
    dispatchPool(state);
}

function retireWorker(state, worker, cause, terminate) {
    const handlers = state.handlers.get(worker);
    if (handlers === undefined) return;
    state.handlers.delete(worker);
    state.disposable.delete(worker);
    worker.off("message", handlers.message);
    worker.off("error", handlers.error);
    worker.off("exit", handlers.exit);
    const index = state.workers.indexOf(worker);
    if (index >= 0) state.workers.splice(index, 1);
    const job = state.active.get(worker);
    state.active.delete(worker);
    worker.unref();
    if (job !== undefined) settleJob(job, "reject", cause);
    dispatchPool(state);
    if (!terminate) {
        state.owned.delete(worker);
        restorePoolCapacity(state);
        return;
    }
    void terminateWorker(state, worker).then(
        () => restorePoolCapacity(state),
        (terminationError) => {
            if (state.closing) return;
            state.failure = new AggregateError(
                [cause, terminationError],
                "embed worker retirement failed",
            );
            rejectQueued(state, state.failure);
        },
    );
}

function workerExitError(code, stage = "") {
    return new Error(`embed worker exited unexpectedly${stage} with code ${String(code)}`);
}

function workerTimeoutError(operation) {
    return new DOMException(
        `embed worker ${operation} exceeded ${WORKER_OPERATION_TIMEOUT_MS}ms`,
        "TimeoutError",
    );
}

function asError(value, fallback) {
    return value instanceof Error ? value : new Error(`${fallback}: ${String(value)}`);
}

// One global queue owns each worker's single in-flight message. Multiple callers
// may overlap document-embedding calls (the service derivation pump does);
// per-call listeners would all consume worker zero's first reply and corrupt the
// text→vector association. The shared scheduler distributes those calls across
// the pool while preserving each caller's input order.
function dispatchPool(state) {
    const failure = state.failure ?? state.initializationFailure;
    if (failure !== null) {
        rejectQueued(state, failure);
        return;
    }
    for (const worker of [...state.workers]) {
        if (state.active.has(worker)) continue;
        let job;
        while ((job = state.queue.shift()) !== undefined && job.settled) { /* skip cancelled queued jobs */ }
        if (job === undefined) return;
        state.active.set(worker, job);
        job.worker = worker;
        try {
            worker.ref();
            job.deadline = setTimeout(
                () => retireWorker(state, worker, workerTimeoutError(`${job.kind} job`), true),
                WORKER_OPERATION_TIMEOUT_MS,
            );
            job.deadline.unref?.();
            worker.postMessage({ kind: job.kind, text: job.text });
        } catch (cause) {
            retireWorker(
                state,
                worker,
                new Error("embed worker dispatch failed", { cause }),
                true,
            );
        }
    }
}

async function enqueueWorkerJob(kind, text, signal) {
    const state = pool();
    const failure = state.failure ?? state.initializationFailure;
    if (failure !== null) throw failure;
    if (state.closing) throw new Error("embedder disposed");
    return new Promise((resolve, reject) => {
        const job = {
            kind,
            text,
            resolve,
            reject,
            settled: false,
            worker: null,
            deadline: undefined,
            cleanup: () => {},
        };
        const abort = () => {
            if (job.settled) return;
            const reason = signal?.reason
                ?? new DOMException("embedding worker operation aborted", "AbortError");
            const worker = job.worker;
            settleJob(job, "reject", reason);
            if (worker !== null) retireWorker(state, worker, reason, true);
        };
        job.cleanup = () => {
            clearTimeout(job.deadline);
            signal?.removeEventListener("abort", abort);
        };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        state.queue.push(job);
        restorePoolCapacity(state);
        dispatchPool(state);
    });
}

function settleJob(job, disposition, value) {
    if (job.settled) return false;
    job.settled = true;
    job.cleanup();
    job.worker = null;
    if (disposition === "resolve") job.resolve(value);
    else job.reject(value);
    return true;
}

function rejectQueued(state, error) {
    for (const job of state.queue) settleJob(job, "reject", error);
    state.queue.length = 0;
}

export async function embedQuery(text, options = {}) {
    if (typeof text !== "string") throw new TypeError("embedQuery: text must be a string");
    return embedQueryWithModel({
        model: LOCAL_QUERY_MODEL,
        text,
        transform: identity,
        dimension,
        label: "local embedding",
        maxRetries: 0,
        signal: options.signal,
    });
}

// Embed corpus documents in input order and report each worker completion.
export async function embedDocuments(texts, { onProgress, signal } = {}) {
    if (!Array.isArray(texts)) throw new TypeError("embedDocuments: texts must be an array");
    return embedDocumentsWithModel({
        model: LOCAL_DOCUMENT_MODEL,
        texts,
        transform: identity,
        dimension,
        label: "local embedding",
        maxRetries: 0,
        maxParallelCalls: WORKERS,
        onProgress,
        signal,
    });
}

async function disposePool(state) {
    state.closing = true;
    cancelWorkerStarts(state);
    const disposable = new Set(
        state.workers.filter((worker) => state.disposable.has(worker) && !state.active.has(worker)),
    );
    const error = new Error("embedder disposed");
    for (const job of [...state.queue, ...state.active.values()]) {
        settleJob(job, "reject", error);
    }
    state.queue.length = 0;
    state.active.clear();
    for (const [worker, handlers] of state.handlers) {
        worker.off("message", handlers.message);
        worker.off("error", handlers.error);
        worker.off("exit", handlers.exit);
        worker.unref();
    }
    state.handlers.clear();
    state.workers.length = 0;
    state.disposable.clear();
    const starts = [...state.starting];
    const forced = [...state.owned].filter((worker) => !disposable.has(worker));
    const [releaseResults, terminationErrors] = await Promise.all([
        Promise.allSettled([...disposable].map((worker) => releaseWorker(state, worker))),
        terminateWorkers(state, forced),
    ]);
    const startErrors = rejectedReasons(await Promise.allSettled(starts))
        .filter((cause) => cause !== state.closeReason);
    const errors = uniqueErrors([
        ...(state.failure === null ? [] : [state.failure]),
        ...rejectedReasons(releaseResults),
        ...startErrors,
        ...terminationErrors,
    ]);
    if (errors.length > 0) throw new AggregateError(errors, "embed worker pool shutdown failed");
}

async function releaseWorker(state, worker) {
    try {
        await requestWorkerRelease(worker);
        state.owned.delete(worker);
    } catch (cause) {
        try {
            await terminateWorker(state, worker);
        } catch (terminationError) {
            throw new AggregateError([cause, terminationError], "embed worker cooperative release failed");
        }
        throw cause;
    }
}

function requestWorkerRelease(worker) {
    return new Promise((resolve, reject) => {
        let acknowledged = false;
        let releaseError = null;
        let settled = false;
        let deadline;
        const cleanup = () => {
            clearTimeout(deadline);
            worker.off("message", message);
            worker.off("error", error);
            worker.off("exit", exit);
        };
        const settle = (action) => {
            if (settled) return;
            settled = true;
            cleanup();
            action();
        };
        const message = (value) => {
            if (value?.disposed === true) {
                acknowledged = true;
            } else if (value?.disposed === false) {
                acknowledged = true;
                releaseError = new Error(`embed worker runtime release failed: ${value.error ?? "unknown"}`);
            }
        };
        const error = (cause) => settle(() => reject(asError(cause, "embed worker failed during release")));
        const exit = (code) => settle(() => {
            if (!acknowledged) reject(workerExitError(code, " during cooperative release"));
            else if (releaseError !== null) reject(releaseError);
            else resolve();
        });
        worker.on("message", message);
        worker.on("error", error);
        worker.on("exit", exit);
        deadline = setTimeout(
            () => settle(() => reject(new DOMException(
                `embed worker release exceeded ${WORKER_RELEASE_TIMEOUT_MS}ms`,
                "TimeoutError",
            ))),
            WORKER_RELEASE_TIMEOUT_MS,
        );
        deadline.unref?.();
        try {
            worker.postMessage({ kind: "dispose" });
        } catch (cause) {
            settle(() => reject(new Error("embed worker release dispatch failed", { cause })));
        }
    });
}

async function terminateWorker(state, worker) {
    const pending = state.terminations.get(worker);
    if (pending !== undefined) return pending;
    const termination = Promise.resolve().then(() => worker.terminate());
    state.terminations.set(worker, termination);
    try {
        const result = await termination;
        state.owned.delete(worker);
        return result;
    } finally {
        if (state.terminations.get(worker) === termination) state.terminations.delete(worker);
    }
}

async function terminateWorkers(state, workers) {
    const results = await Promise.allSettled(
        workers.map((worker) => terminateWorker(state, worker)),
    );
    return rejectedReasons(results);
}

function uniqueErrors(errors) {
    return [...new Set(errors)];
}

function rejectedReasons(results) {
    return results
        .filter((result) => result.status === "rejected")
        .flatMap((result) => result.reason instanceof AggregateError
            ? [...result.reason.errors]
            : [result.reason]);
}

// Release the WASM session and tear down the worker pool so the process exits.
// Concurrent calls join one attempt; later use re-lazy-inits a new generation.
export async function dispose() {
    if (disposePromise !== null) return disposePromise;
    const disposal = disposeResources();
    disposePromise = disposal;
    try {
        await disposal;
    } finally {
        if (disposePromise === disposal) disposePromise = null;
    }
}

async function disposeResources() {
    const runtime = runtimePromise;
    const workerPool = poolState;
    runtimePromise = null;
    poolState = null;
    // Initialization failures are already delivered to the operation that
    // created each promise. Pool initialization also releases partial workers;
    // only failures from releasing an acquired resource belong to teardown.
    const results = await Promise.allSettled([
        runtime === null ? Promise.resolve() : runtime.then(releaseRuntime, () => undefined),
        workerPool === null ? Promise.resolve() : disposePool(workerPool),
    ]);
    const errors = rejectedReasons(results);
    if (errors.length > 0) throw new AggregateError(errors, "embedder shutdown failed");
}
