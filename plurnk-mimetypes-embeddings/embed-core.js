// Single-threaded embedding core, shared verbatim by the main-thread embed()
// (index.js) and each pool worker (embed-worker.js) so the two can never
// diverge. The WASM runtime is pinned to ONE thread here on purpose: parallelism
// is across workers (data-parallel), not within an inference (intra-op). One
// thread per unit keeps each embed bit-identical to every other — same model
// identity regardless of how many workers run — and holds no event-loop handles.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web";

ort.env.wasm.numThreads = 1;

const here = path.dirname(fileURLToPath(import.meta.url));

export const dimension = 384;

// The model's token window — past this embed() truncates (keeping [CLS] … [SEP])
// so the position table never overflows. all-MiniLM-L6-v2 = 512.
export const maxTokens = 512;

// Load the tokenizer + onnx session from the bundled model/ directory. Hermetic:
// only local files are read. Returned handle is passed to embedText/countTokens.
export async function loadRuntime() {
    const tok = JSON.parse(readFileSync(path.join(here, "model", "tokenizer.json"), "utf-8"));
    const cfg = JSON.parse(readFileSync(path.join(here, "model", "tokenizer_config.json"), "utf-8"));
    const tokenizer = new Tokenizer(tok, cfg);
    const sepId = tokenizer.token_to_id("[SEP]");
    if (typeof sepId !== "number") throw new Error("embed: tokenizer has no [SEP] token");
    const session = await ort.InferenceSession.create(path.join(here, "model", "onnx", "model_quantized.onnx"));
    return { tokenizer, sepId, session };
}

const toI64 = (a) => BigInt64Array.from(a, BigInt);

// text → 1536 owned bytes (Float32 × 384), masked mean-pooled + L2-normalized.
export async function embedText({ tokenizer, sepId, session }, text) {
    const enc = tokenizer.encode(text, { add_special_tokens: true, return_token_type_ids: true });
    let { ids, attention_mask: mask, token_type_ids: types } = enc;
    if (ids.length > maxTokens) {
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
    if (hidden !== dimension) throw new Error(`embed: expected hidden ${dimension}, got ${hidden}`);
    const out = new Float32Array(hidden);
    let denom = 0;
    for (let t = 0; t < seq; t += 1) {
        const m = mask[t];
        if (!m) continue;
        denom += m;
        const base = t * hidden;
        for (let h = 0; h < hidden; h += 1) out[h] += lhs.data[base + h] * m;
    }
    for (let h = 0; h < hidden; h += 1) out[h] /= denom;
    let norm = 0;
    for (let h = 0; h < hidden; h += 1) norm += out[h] * out[h];
    norm = Math.sqrt(norm);
    for (let h = 0; h < hidden; h += 1) out[h] /= norm;
    return new Uint8Array(out.buffer);
}

// Untruncated token count in the model's own tokenizer (CLS/SEP included) — the
// losslessness primitive for the chunker (#1).
export function countTokensWith(tokenizer, text) {
    return tokenizer.encode(text, { add_special_tokens: true }).ids.length;
}

export async function releaseRuntime(runtime) {
    await runtime?.session?.release?.();
}
