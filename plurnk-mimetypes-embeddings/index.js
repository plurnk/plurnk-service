// Opt-in embedder for @plurnk/plurnk-mimetypes' "embedding" channel
// (plurnk-mimetypes#24). The framework duck-checks exactly this surface:
// embed(text) → Promise<Uint8Array> of native-endian raw Float32 bytes
// (4 × dimension), plus the dimension constant.
//
// Runtime: onnxruntime-web (WASM) + @huggingface/tokenizers — pure portable
// JS/WASM, no native N-API addon (the move off transformers.js/onnxruntime-node,
// plurnk-mimetypes#36). The embed math lives in embed-core.js, shared verbatim
// by the single main-thread path here and the pool workers.
//
// Throughput: embed() runs one text on the calling thread (the framework's
// per-entry path). embedBatch() spreads many texts across a pool of
// single-threaded workers — data-parallel, so each vector stays bit-identical
// (same model identity) while N cores are used. The host (plurnk-service) drives
// bulk corpus embedding through embedBatch with onProgress so a long run is
// visible, not opaque (plurnk-mimetypes-embeddings#2).
//
// Model: Xenova/all-MiniLM-L6-v2, q8 quantized onnx, bundled in model/ at the
// revision in .model-pin. Hermetic: only local files are read.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRuntime, embedText, countTokensWith, releaseRuntime, dimension, maxTokens } from "./embed-core.js";

export { dimension, maxTokens };

const here = path.dirname(fileURLToPath(import.meta.url));

// The two facts that fully determine the output vectors: the HF revision
// (single source of truth = .model-pin) and the quantization. The runtime and
// the worker count are deliberately NOT part of the identity — every unit is
// single-threaded, so output is bit-identical regardless.
const REPO = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8";
const PIN = readFileSync(path.join(here, ".model-pin"), "utf-8").trim();

// Model identity, surfaced by the framework as ProcessResult.embeddingModel.
// DERIVED, never a hand-synced literal.
export const model = `${REPO}@${PIN.slice(0, 8)}+${DTYPE}`;

// embedBatch() pool size. REQUIRED — there is no default. Each worker holds its
// own model copy, so the count is a memory↔throughput decision only the operator
// can make; the embedder will not guess it (no CPU heuristic, no magic 8). Set
// PLURNK_EMBED_WORKERS to a positive integer (see .env.example). Unset, empty, or
// malformed → crash on load. No fallback, ever.
const WORKERS = requireWorkers(process.env.PLURNK_EMBED_WORKERS);

function requireWorkers(raw) {
    const n = Number(raw);
    if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 1) {
        throw new RangeError(
            `PLURNK_EMBED_WORKERS is required and must be a positive integer; got ${JSON.stringify(raw)}. `
            + `Set it (see .env.example) — the embedBatch worker count is a memory↔throughput `
            + `decision the embedder will not make for you.`,
        );
    }
    return n;
}

let runtimePromise = null;
function runtime() {
    runtimePromise ??= loadRuntime();
    return runtimePromise;
}

// text → 1536 bytes on the calling thread. The framework's single-entry path.
export async function embed(text) {
    return embedText(await runtime(), text);
}

// Untruncated token count in the model's own tokenizer (CLS/SEP included).
export async function countTokens(text) {
    return countTokensWith((await runtime()).tokenizer, text);
}

let poolPromise = null;
function pool() {
    poolPromise ??= (async () => {
        const url = new URL("./embed-worker.js", import.meta.url);
        // execArgv: [] — don't inherit the parent's entry-point flags (--eval,
        // --input-type, --test, --watch); they don't apply to a file-based worker
        // and ERR_INPUT_TYPE_NOT_ALLOWED if --input-type leaks through.
        const workers = Array.from({ length: WORKERS }, () => new Worker(url, { execArgv: [] }));
        await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
            w.once("message", (m) => (m?.ready ? resolve() : reject(new Error(`embed worker failed to load: ${m?.error ?? "unknown"}`))));
            w.once("error", reject);
        })));
        return workers;
    })();
    return poolPromise;
}

// Embed many texts across the worker pool, returning vectors in input order.
// onProgress({completed, total}) fires as each finishes — the host's progress
// signal. signal (AbortSignal) cancels in flight. Bit-identical to embed() per
// text (each worker is single-threaded). The pool is lazy + persistent across
// calls; unref'd while idle so it never holds the event loop open (#36), and
// fully released by dispose().
export async function embedBatch(texts, { onProgress, signal } = {}) {
    if (!Array.isArray(texts)) throw new TypeError("embedBatch: texts must be an array");
    if (texts.length === 0) return [];
    const workers = await pool();
    const results = new Array(texts.length);
    let next = 0;
    let completed = 0;
    workers.forEach((w) => w.ref());
    const onError = new Map();
    try {
        await new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(new DOMException("embedBatch aborted", "AbortError")); return; }
            const onAbort = () => reject(new DOMException("embedBatch aborted", "AbortError"));
            signal?.addEventListener("abort", onAbort, { once: true });
            const finish = (err) => {
                signal?.removeEventListener("abort", onAbort);
                workers.forEach((w) => w.removeListener("error", onError.get(w)));
                if (err) reject(err); else resolve();
            };
            for (const w of workers) {
                const h = (e) => finish(e);
                onError.set(w, h);
                w.on("error", h);
            }
            const assign = (w) => {
                if (next >= texts.length) return;
                const idx = next++;
                w.once("message", (msg) => {
                    if (msg.error) { finish(new Error(`embed failed at index ${idx}: ${msg.error}`)); return; }
                    results[idx] = new Uint8Array(msg.buffer);
                    completed += 1;
                    onProgress?.({ completed, total: texts.length });
                    if (completed === texts.length) { finish(); return; }
                    assign(w);
                });
                w.postMessage({ index: idx, text: texts[idx] });
            };
            workers.forEach(assign);
        });
    } finally {
        workers.forEach((w) => w.unref());
    }
    return results;
}

// Release the WASM session and tear down the worker pool so the process exits.
// Idempotent; embed()/embedBatch() re-lazy-init afterward.
export async function dispose() {
    if (runtimePromise) {
        const pending = runtimePromise;
        runtimePromise = null;
        try { await releaseRuntime(await pending); } catch { /* never loaded */ }
    }
    if (poolPromise) {
        const pending = poolPromise;
        poolPromise = null;
        try { await Promise.all((await pending).map((w) => w.terminate())); } catch { /* never started */ }
    }
}
