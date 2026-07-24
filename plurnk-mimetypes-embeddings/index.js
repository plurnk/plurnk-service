// Opt-in embedder for @plurnk/plurnk-mimetypes' "embedding" channel
// (plurnk-mimetypes#24). The framework duck-checks exactly this surface:
// embed(text) → Promise<Uint8Array> of native-endian raw Float32 bytes
// (4 × dimension), plus the dimension constant.
//
// TWO MODES, chosen at load (plurnk-mimetypes#46, routed from service#319):
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
//   maxTokens/countTokens are absent → embedderInfo() reports null and the host
//   stays on whole-entry chunks (honest; the window is the endpoint's fact, not
//   ours to invent).
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    loadRuntime, embedText, releaseRuntime,
    dimension as localDimension, maxTokens as localMaxTokens,
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
        maxTokens: remoteMaxTokens(),
    };
}

// PLURNK_MIMETYPES_EMBED_MAX_TOKENS — the remote model's token window, an
// OPERATOR-DECLARED fact (mimetypes#50): the endpoint owner knows their model.
// Optional: unset → window unknown (hosts take their null-window lane).
// Malformed → crash. Remote-only by nature — the bundled model's window is a
// model fact the operator cannot re-declare (checked in local mode below).
function remoteMaxTokens() {
    const raw = process.env.PLURNK_MIMETYPES_EMBED_MAX_TOKENS;
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(`PLURNK_MIMETYPES_EMBED_MAX_TOKENS must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return n;
}
const REMOTE = resolveRemote();
// Set-to-EMPTY equals unset (the .env.defaults assembled floor sets every key,
// empty when no default — mimetypes#52); only a non-empty value in local mode
// is the contradiction that crashes.
if (!REMOTE && (process.env.PLURNK_MIMETYPES_EMBED_MAX_TOKENS ?? "").trim() !== "") {
    throw new RangeError(
        "PLURNK_MIMETYPES_EMBED_MAX_TOKENS is remote-only: the bundled model's window is a "
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
        out[item.index] = new Uint8Array(Float32Array.from(item.embedding).buffer);
    }
    if (out.some((v) => v === undefined)) throw new Error(`remote embeddings: response from ${REMOTE.url} missing indices`);
    return out;
}

// Mode-resolved identity facts. Remote: dimension PROBED at load (one request;
// unreachable endpoint = crash the import = boot-time surfacing); identity
// folds model + dimension so an embedder swap re-derives the space; no
// maxTokens/countTokens (no local tokenizer — embedderInfo() → null → the host
// stays on whole-entry chunks). Local: the bundled model's facts, identity
// string byte-identical to every previously stored id.
export let dimension;
export let maxTokens;
export let model;
if (REMOTE) {
    const [probe] = await remoteEmbedMany(["plurnk dimension probe"]);
    const dim = probe.byteLength / 4;
    if (!Number.isInteger(dim) || dim < 1) throw new Error(`remote embeddings: probe returned invalid dimension ${dim} from ${REMOTE.url}`);
    dimension = dim;
    maxTokens = REMOTE.maxTokens;
    model = `remote:${REMOTE.model}@d${dimension}`;
} else {
    const REPO = "Xenova/all-MiniLM-L6-v2";
    const DTYPE = "q8";
    const PIN = readFileSync(path.join(here, ".model-pin"), "utf-8").trim();
    dimension = localDimension;
    maxTokens = localMaxTokens;
    model = `${REPO}@${PIN.slice(0, 8)}+${DTYPE}`;
}

let runtimePromise = null;
function runtime() {
    runtimePromise ??= loadRuntime();
    return runtimePromise;
}

// text → 4×dimension bytes. Local: WASM on the calling thread. Remote: one
// endpoint request (failures throw with the endpoint named; the host's
// degrade-to-FTS + telemetry handling is service-side, per #46).
export async function embed(text) {
    if (REMOTE) return (await remoteEmbedMany([text]))[0];
    return embedText(await runtime(), text);
}

// Untruncated token count in the bundled model's own tokenizer (CLS/SEP
// included), scheduled through the same host-adaptive worker pool as batches.
// LOCAL only — in remote mode the export is UNDEFINED, not a
// throwing function: the seam duck-checks `typeof countTokens === "function"`
// to distinguish "has a counter" from "hasn't" (mimetypes#50), and a throwing
// decoy would read as the former.
export const countTokens = REMOTE
    ? undefined
    : async function countTokens(text) {
        return enqueueWorkerJob("count", text);
    };

let poolPromise = null;
function pool() {
    poolPromise ??= (async () => {
        const url = new URL("./embed-worker.js", import.meta.url);
        // execArgv: [] — don't inherit the parent's entry-point flags (--eval,
        // --input-type, --test, --watch); they don't apply to a file-based worker
        // and ERR_INPUT_TYPE_NOT_ALLOWED if --input-type leaks through.
        const workers = Array.from({ length: WORKERS }, () => new Worker(url, { execArgv: [] }));
        await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
            const ready = (m) => {
                w.off("error", reject);
                if (m?.ready) resolve();
                else reject(new Error(`embed worker failed to load: ${m?.error ?? "unknown"}`));
            };
            w.once("message", ready);
            w.once("error", reject);
        })));
        const state = { workers, queue: [], active: new Map() };
        for (const worker of workers) {
            worker.on("message", (message) => {
                const job = state.active.get(worker);
                if (job === undefined) return;
                state.active.delete(worker);
                worker.unref();
                if (!job.settled) {
                    job.settled = true;
                    job.cleanup();
                    if (message.error) job.reject(new Error(message.error));
                    else if (job.kind === "count") job.resolve(message.count);
                    else job.resolve(new Uint8Array(message.buffer));
                }
                dispatchPool(state);
            });
            worker.on("error", (error) => {
                const job = state.active.get(worker);
                state.active.delete(worker);
                worker.unref();
                if (job !== undefined && !job.settled) {
                    job.settled = true;
                    job.cleanup();
                    job.reject(error);
                }
                dispatchPool(state);
            });
        }
        return state;
    })();
    return poolPromise;
}

// One global queue owns each worker's single in-flight message. Multiple callers
// may overlap singleton embedBatch() calls (the service derivation pump does);
// per-call listeners would all consume worker zero's first reply and corrupt the
// text→vector association. The shared scheduler distributes those calls across
// the pool while preserving each caller's input order.
function dispatchPool(state) {
    for (const worker of state.workers) {
        if (state.active.has(worker)) continue;
        let job;
        while ((job = state.queue.shift()) !== undefined && job.settled) { /* skip cancelled queued jobs */ }
        if (job === undefined) return;
        state.active.set(worker, job);
        worker.ref();
        worker.postMessage({ kind: job.kind, text: job.text });
    }
}

async function enqueueWorkerJob(kind, text, signal) {
    const state = await pool();
    return new Promise((resolve, reject) => {
        const job = { kind, text, resolve, reject, settled: false, cleanup: () => {} };
        const abort = () => {
            if (job.settled) return;
            job.settled = true;
            job.cleanup();
            reject(new DOMException("embedBatch aborted", "AbortError"));
        };
        job.cleanup = () => signal?.removeEventListener("abort", abort);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        state.queue.push(job);
        dispatchPool(state);
    });
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
    const producer = async () => {
        while (next < texts.length) {
            const index = next++;
            results[index] = await enqueueWorkerJob("embed", texts[index], signal);
            completed += 1;
            onProgress?.({ completed, total: texts.length });
        }
    };
    // The pool itself is the concurrency bound. Do not retain one Promise and
    // queued closure per chunk: legitimate tokenizer assets can contain tens of
    // thousands of chunks, and several entries may overlap.
    await Promise.all(Array.from(
        { length: Math.min(texts.length, WORKERS) },
        () => producer(),
    ));
    return results;
}

// Release the WASM session and tear down the worker pool so the process exits.
// Idempotent; embed()/embedBatch() re-lazy-init afterward. Remote mode holds no
// native state — nothing to release.
export async function dispose() {
    if (runtimePromise) {
        const pending = runtimePromise;
        runtimePromise = null;
        try { await releaseRuntime(await pending); } catch { /* never loaded */ }
    }
    if (poolPromise) {
        const pending = poolPromise;
        poolPromise = null;
        try {
            const state = await pending;
            const error = new Error("embedder disposed");
            for (const job of [...state.queue, ...state.active.values()]) {
                if (!job.settled) {
                    job.settled = true;
                    job.cleanup();
                    job.reject(error);
                }
            }
            await Promise.all(state.workers.map((w) => w.terminate()));
        } catch { /* never started */ }
    }
}
