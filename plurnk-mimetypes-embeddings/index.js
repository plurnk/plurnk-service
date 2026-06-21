// Opt-in embedder for @plurnk/plurnk-mimetypes' "embedding" channel
// (plurnk-mimetypes#24). The framework duck-checks exactly this surface:
// embed(text) → Promise<Uint8Array> of native-endian raw Float32 bytes
// (4 × dimension), plus the dimension constant.
//
// Runtime: onnxruntime-web (WASM) + @huggingface/tokenizers — both pure
// portable JS/WASM, no native N-API addon. This is the deliberate move off
// transformers.js/onnxruntime-node (plurnk-mimetypes#36): the native runtime's
// worker pool held active+referenced libuv handles that kept a consumer's event
// loop alive at exit, and shipped a 513 MB per-platform binary. The WASM
// runtime has no such handles (the loop drains on its own) and runs anywhere
// Node/Bun/Deno/edge runs. Output is vector-identical to the old native path
// (Δ ~1e-8, last-mantissa-bit summation noise) — same model identity, no
// re-embed; guarded by the "vector-preserving" baseline test in index.test.js.
//
// Model: Xenova/all-MiniLM-L6-v2, q8 quantized onnx, bundled in model/ at the
// revision in .model-pin. Hermetic by construction: we only ever read local
// files — there is no fetcher to disable.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web";

// Single-threaded WASM: no worker threads to keep the event loop alive (the
// #36 property), and bit-stable across machines (no SIMD-width variance).
ort.env.wasm.numThreads = 1;

const here = path.dirname(fileURLToPath(import.meta.url));

export const dimension = 384;

// The model's token window — the point past which embed() truncates. A pure
// model fact (all-MiniLM-L6-v2 = 512, its max_position_embeddings); feeding more
// would overflow the position table. plurnk-service's lossless chunker uses it
// as the per-chunk budget (plurnk-mimetypes-embeddings#1).
export const maxTokens = 512;

// The two facts that fully determine the output vectors: the HF revision
// (single source of truth = .model-pin) and the quantization. The runtime
// (native vs WASM) is deliberately NOT part of the identity — the two agree to
// float32 epsilon, so vectors stay comparable across the switch.
const REPO = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8";
const PIN = readFileSync(path.join(here, ".model-pin"), "utf-8").trim();

// Model identity, surfaced by the framework as ProcessResult.embeddingModel.
// Consumers store it alongside each vector BLOB — vectors from a different
// revision OR quantization are silently incomparable, and this is the staleness
// detector. DERIVED, never a hand-synced literal.
export const model = `${REPO}@${PIN.slice(0, 8)}+${DTYPE}`;

let tokenizerPromise = null;

// The WordPiece tokenizer, built straight from the bundled tokenizer.json +
// config — the same artifacts (and the same library) transformers.js delegated
// to, so tokenization is byte-identical to the old path. Kept separate from the
// onnx session so countTokens() never spins up inference.
function getTokenizer() {
    tokenizerPromise ??= (async () => {
        const tok = JSON.parse(readFileSync(path.join(here, "model", "tokenizer.json"), "utf-8"));
        const cfg = JSON.parse(readFileSync(path.join(here, "model", "tokenizer_config.json"), "utf-8"));
        const tokenizer = new Tokenizer(tok, cfg);
        const sepId = tokenizer.token_to_id("[SEP]");
        if (typeof sepId !== "number") throw new Error("embed: tokenizer has no [SEP] token");
        return { tokenizer, sepId };
    })();
    return tokenizerPromise;
}

let sessionPromise = null;

function getSession() {
    sessionPromise ??= ort.InferenceSession.create(path.join(here, "model", "onnx", "model_quantized.onnx"));
    return sessionPromise;
}

const toI64 = (a) => BigInt64Array.from(a, BigInt);

// Masked mean-pool over the sequence, then L2-normalize → 1536 owned bytes.
function poolNormalize(hiddenStates, seq, hidden, mask) {
    const out = new Float32Array(hidden);
    let denom = 0;
    for (let t = 0; t < seq; t += 1) {
        const m = mask[t];
        if (!m) continue;
        denom += m;
        const base = t * hidden;
        for (let h = 0; h < hidden; h += 1) out[h] += hiddenStates[base + h] * m;
    }
    for (let h = 0; h < hidden; h += 1) out[h] /= denom;
    let norm = 0;
    for (let h = 0; h < hidden; h += 1) norm += out[h] * out[h];
    norm = Math.sqrt(norm);
    for (let h = 0; h < hidden; h += 1) out[h] /= norm;
    // out.buffer is exactly 4 × dimension bytes at offset 0 — safe as a BLOB.
    return new Uint8Array(out.buffer);
}

// text → 1536 bytes (Float32 × 384), mean-pooled, L2-normalized. Input beyond
// the model's 512-token window is truncated (keeping [CLS] … [SEP]) so the
// position table never overflows. The returned Uint8Array owns its buffer
// exactly — safe to store verbatim as a BLOB.
export async function embed(text) {
    const [{ tokenizer, sepId }, session] = await Promise.all([getTokenizer(), getSession()]);
    const enc = tokenizer.encode(text, { add_special_tokens: true, return_token_type_ids: true });
    let { ids, attention_mask: mask, token_type_ids: types } = enc;
    if (ids.length > maxTokens) {
        // Hard-truncate to the window; force the final slot back to [SEP].
        ids = ids.slice(0, maxTokens);
        mask = mask.slice(0, maxTokens);
        types = types.slice(0, maxTokens);
        ids[maxTokens - 1] = sepId;
    }
    const seq = ids.length;
    const { last_hidden_state: lhs } = await session.run({
        input_ids: new ort.Tensor("int64", toI64(ids), [1, seq]),
        attention_mask: new ort.Tensor("int64", toI64(mask), [1, seq]),
        token_type_ids: new ort.Tensor("int64", toI64(types), [1, seq]),
    });
    const hidden = lhs.dims[2];
    if (hidden !== dimension) {
        throw new Error(`embed: expected last_hidden_state hidden ${dimension}, got ${hidden}`);
    }
    return poolNormalize(lhs.data, seq, hidden, mask);
}

// Token count in the MODEL'S OWN tokenizer, including the special tokens
// (CLS/SEP) embed() adds — so "count <= maxTokens" is exactly the condition
// under which embed() does NOT truncate. The losslessness primitive for
// plurnk-service's chunker (#1). NOT truncated here — a 2000-token input
// honestly returns 2000 (the chunker needs to know it overflows the window).
export async function countTokens(text) {
    const { tokenizer } = await getTokenizer();
    return tokenizer.encode(text, { add_special_tokens: true }).ids.length;
}

// Release the WASM inference session and drop the caches. Unlike the old native
// runtime (plurnk-mimetypes#36), the single-threaded WASM backend holds no
// libuv handles, so a consumer drains and exits without this — but releasing
// the session frees its memory promptly. Idempotent; embed()/countTokens()
// re-lazy-init if called again afterward.
export async function dispose() {
    if (sessionPromise) {
        const pending = sessionPromise;
        sessionPromise = null;
        try {
            const session = await pending;
            await session?.release?.();
        } catch {
            // session never finished loading — nothing to release.
        }
    }
    tokenizerPromise = null;
}
