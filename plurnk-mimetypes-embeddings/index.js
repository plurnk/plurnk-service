// Portable implementation of @plurnk/plurnk-mimetypes' explicitly requested
// embedding seam ({§mimetype-embedding}). The framework duck-checks this surface:
// embed(text) → Promise<Uint8Array> in {§mimetype-embedding-wire}
// (4 × dimension), plus the dimension constant.
//
// TWO MODES, chosen at load:
//
//   LOCAL (default, PLURNK_MIMETYPES_EMBED_BASE_URL unset) — the bundled WASM
//   path, unchanged: onnxruntime-web + @huggingface/tokenizers, hermetic, no
//   network. embed() on the calling thread; embedBatch() data-parallel across a
//   worker pool (PLURNK_MIMETYPES_EMBED_WORKERS).
//
//   REMOTE (BASE_URL set) — an OpenAI-compatible `/v1/embeddings` endpoint
//   (BYO GPU: llama-server, vLLM, hosted). PLURNK_MIMETYPES_EMBED_MODEL is
//   REQUIRED; PLURNK_MIMETYPES_EMBED_API_KEY optional (Bearer). The dimension
//   is PROBED at load with one request — an unreachable/misconfigured endpoint
//   crashes the import, so the framework's present-but-broken rule surfaces it
//   at boot, never mid-query. The identity folds model + dimension
//   (`remote:<model>@d<dim>`), so an embedder swap re-derives the vector space
//   (service folds it into deep_hash). No local tokenizer in remote mode →
//   contextWindow may be operator-declared; countTokens is absent because the
//   endpoint does not expose its tokenizer.
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

const here = path.dirname(fileURLToPath(import.meta.url));


// Remote-mode config, resolved once at load. BASE_URL is the OpenAI-convention
// base (e.g. http://127.0.0.1:8080/v1) — the client appends /embeddings.
// BASE_URL set without MODEL is a misconfiguration: crash, never guess a model
// name the endpoint might not serve.
function resolveRemote() {
    const base = process.env.PLURNK_MIMETYPES_EMBED_BASE_URL;
    if (base === undefined || base.trim() === "") return null;
    const modelName = process.env.PLURNK_MIMETYPES_EMBED_MODEL;
    if (modelName === undefined || modelName.trim() === "") {
        throw new RangeError(
            "PLURNK_MIMETYPES_EMBED_MODEL is required when PLURNK_MIMETYPES_EMBED_BASE_URL is set "
            + "— the embedder will not guess which model the endpoint serves (see .env.example).",
        );
    }
    return {
        url: `${base.trim().replace(/\/+$/, "")}/embeddings`,
        model: modelName.trim(),
        key: process.env.PLURNK_MIMETYPES_EMBED_API_KEY,
        contextWindow: remoteContextWindow(),
    };
}

// PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW — the remote model's input window, an
// OPERATOR-DECLARED fact: the endpoint owner knows their model.
// Optional: unset → window unknown (hosts take their null-window lane).
// Malformed → crash. Remote-only by nature — the bundled model's window is a
// model fact the operator cannot re-declare (checked in local mode below).
function remoteContextWindow() {
    const raw = process.env.PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW;
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(`PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return n;
}
const REMOTE = resolveRemote();
// Set-to-EMPTY equals unset (the .env.defaults assembled floor sets every key,
// empty when no default); only a non-empty value in local mode
// is the contradiction that crashes.
if (!REMOTE && (process.env.PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW ?? "").trim() !== "") {
    throw new RangeError(
        "PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW is remote-only: the bundled model's window is a "
        + "model fact (512), not operator config. Unset it, or set PLURNK_MIMETYPES_EMBED_BASE_URL.",
    );
}

// embedBatch() pool size (LOCAL mode only — remote has no pool). Each worker
// holds its own model copy. Unset/empty uses every available core while leaving
// one free on hosts larger than four cores; -1 explicitly claims every core,
// and a positive value is an operator-selected resource budget.
const WORKERS = REMOTE ? null : requireWorkers(process.env.PLURNK_MIMETYPES_EMBED_WORKERS);

function requireWorkers(raw) {
    if (raw === undefined || raw.trim() === "") {
        const cores = availableParallelism();
        return cores <= 4 ? cores : cores - 1;
    }
    const n = Number(raw);
    if (n === -1) return availableParallelism();
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(
            `PLURNK_MIMETYPES_EMBED_WORKERS must be -1 (match cores) or a positive integer; got ${JSON.stringify(raw)}.`,
        );
    }
    return n;
}

// POST the OpenAI-compatible embeddings request; texts in → Uint8Array[] out,
// input order (data[].index is authoritative). Every failure names the
// endpoint; a wrong-shaped response is a contract violation, never coerced.
async function remoteEmbedMany(texts, signal) {
    const res = await fetch(REMOTE.url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(REMOTE.key ? { authorization: `Bearer ${REMOTE.key}` } : {}),
        },
        body: JSON.stringify({ model: REMOTE.model, input: texts }),
        ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
        const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
        throw new Error(`remote embeddings: ${res.status} ${res.statusText} from ${REMOTE.url}${detail ? ` — ${detail}` : ""}`);
    }
    const body = await res.json();
    if (!Array.isArray(body?.data) || body.data.length !== texts.length) {
        throw new Error(`remote embeddings: expected ${texts.length} vectors from ${REMOTE.url}, got ${Array.isArray(body?.data) ? body.data.length : "no data array"}`);
    }
    const out = new Array(texts.length);
    for (const item of body.data) {
        if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= texts.length || !Array.isArray(item?.embedding)) {
            throw new Error(`remote embeddings: malformed data item from ${REMOTE.url}`);
        }
        if (dimension !== undefined && item.embedding.length !== dimension) {
            throw new Error(`remote embeddings: ${REMOTE.url} returned dimension ${item.embedding.length}, expected ${dimension} — vectors from mixed dimensions are incomparable`);
        }
        out[item.index] = EmbeddingVector.encode(
            item.embedding,
            dimension,
            `remote embeddings: vector ${item.index} from ${REMOTE.url}`,
        );
    }
    if (out.some((v) => v === undefined)) throw new Error(`remote embeddings: response from ${REMOTE.url} missing indices`);
    return out;
}

// Mode-resolved identity facts. Remote: dimension PROBED at load (one request;
// unreachable endpoint = crash the import = boot-time surfacing); identity
// folds model + dimension so an embedder swap re-derives the space; no
// countTokens (no local tokenizer); contextWindow is operator-declared or
// undefined. Local mode exposes the bundled model's facts.
export let dimension;
export let contextWindow;
export let model;
if (REMOTE) {
    const [probe] = await remoteEmbedMany(["plurnk dimension probe"]);
    const dim = probe.byteLength / 4;
    if (!Number.isInteger(dim) || dim < 1) throw new Error(`remote embeddings: probe returned invalid dimension ${dim} from ${REMOTE.url}`);
    dimension = dim;
    contextWindow = REMOTE.contextWindow;
    model = `remote:${REMOTE.model}@d${dimension}`;
} else {
    const REPO = "Xenova/all-MiniLM-L6-v2";
    const DTYPE = "q8";
    const PIN = readFileSync(path.join(here, ".model-pin"), "utf-8").trim();
    dimension = localDimension;
    contextWindow = localContextWindow;
    model = `${REPO}@${PIN.slice(0, 8)}+${DTYPE}`;
}

let runtimePromise = null;
let disposePromise = null;
function runtime() {
    runtimePromise ??= loadRuntime();
    return runtimePromise;
}

// text → 4×dimension bytes. Local: WASM on the calling thread. Remote: one
// endpoint request. Failures throw with the endpoint named;
// {§mimetype-embedding} leaves consumer recovery outside this artifact.
export async function embed(text) {
    if (REMOTE) return (await remoteEmbedMany([text]))[0];
    const bytes = await embedText(await runtime(), text);
    return EmbeddingVector.encode(
        new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT),
        dimension,
        "local embedding",
    );
}

// Untruncated token count in the bundled model's own tokenizer (CLS/SEP
// included), scheduled through the same host-adaptive worker pool as batches.
// LOCAL only — in remote mode the export is UNDEFINED, not a
// throwing function: the seam duck-checks `typeof countTokens === "function"`
// to distinguish "has a counter" from "hasn't", and a throwing
// decoy would read as the former.
export const countTokens = REMOTE
    ? undefined
    : async function countTokens(text, { signal } = {}) {
        return enqueueWorkerJob("count", text, signal);
    };

// A local worker executes one isolated unit: model startup, one exact token
// count, or one at-most-window embedding. Five minutes is a deliberately wide
// internal liveness rail, not an operator throughput target. Cancellation and
// teardown remain immediate and do not wait for this deadline.
const WORKER_OPERATION_TIMEOUT_MS = 300_000;

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
                else if (message?.ready === true) resolve();
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
// may overlap singleton embedBatch() calls (the service derivation pump does);
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

// Embed many texts, returning vectors in input order. Local: data-parallel
// across the worker pool, onProgress per completion, AbortSignal cancels.
// Remote: ONE request carrying the whole input array (the OpenAI contract) —
// the endpoint owns its batching limits; onProgress fires once on completion;
// signal aborts the fetch. Bit-identical to embed() per text in both modes.
export async function embedBatch(texts, { onProgress, signal } = {}) {
    if (!Array.isArray(texts)) throw new TypeError("embedBatch: texts must be an array");
    if (texts.length === 0) return [];
    if (REMOTE) {
        const out = await remoteEmbedMany(texts, signal);
        onProgress?.({ completed: texts.length, total: texts.length });
        return out;
    }
    const results = new Array(texts.length);
    let completed = 0;
    let next = 0;
    const batchAbort = new AbortController();
    const batchSignal = signal === undefined
        ? batchAbort.signal
        : AbortSignal.any([signal, batchAbort.signal]);
    const producer = async () => {
        while (next < texts.length) {
            const index = next++;
            results[index] = await enqueueWorkerJob("embed", texts[index], batchSignal);
            completed += 1;
            onProgress?.({ completed, total: texts.length });
        }
    };
    // The pool itself is the concurrency bound. Do not retain one Promise and
    // queued closure per chunk: legitimate tokenizer assets can contain tens of
    // thousands of chunks, and several entries may overlap.
    const producers = Array.from(
        { length: Math.min(texts.length, WORKERS) },
        () => producer(),
    );
    try {
        await Promise.all(producers);
    } catch (error) {
        if (!batchAbort.signal.aborted) batchAbort.abort(error);
        await Promise.allSettled(producers);
        throw error;
    }
    return results;
}

async function disposePool(state) {
    state.closing = true;
    cancelWorkerStarts(state);
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
    const starts = [...state.starting];
    const terminationErrors = await terminateWorkers(state, [...state.owned]);
    const startErrors = rejectedReasons(await Promise.allSettled(starts))
        .filter((cause) => cause !== state.closeReason);
    const errors = uniqueErrors([
        ...(state.failure === null ? [] : [state.failure]),
        ...startErrors,
        ...terminationErrors,
    ]);
    if (errors.length > 0) throw new AggregateError(errors, "embed worker pool shutdown failed");
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
// Remote mode holds no native state — nothing to release.
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
