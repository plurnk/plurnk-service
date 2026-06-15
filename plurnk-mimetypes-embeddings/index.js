// Opt-in embedder for @plurnk/plurnk-mimetypes' "embedding" channel
// (plurnk-mimetypes#24). The framework duck-checks exactly this surface:
// embed(text) → Promise<Uint8Array> of native-endian raw Float32 bytes
// (4 × dimension), plus the dimension constant.
//
// Model: Xenova/all-MiniLM-L6-v2, q8 quantized onnx, bundled in model/ at
// the revision in .model-pin. Hermetic: transformers.js is locked to the
// bundled directory and remote fetches are disabled process-wide — this is
// a global env mutation, deliberate enforcement, not a default.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here;
env.allowRemoteModels = false;

export const dimension = 384;

// The two facts that fully determine the output vectors: the HF revision
// (single source of truth = .model-pin, the same file fetch-model.mjs pins
// against) and the quantization. DTYPE is shared with the pipeline() call
// below so the identity can never disagree with what actually ran.
const REPO = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8";
const PIN = readFileSync(path.join(here, ".model-pin"), "utf-8").trim();

// Model identity, surfaced by the framework as ProcessResult.embeddingModel.
// Consumers store it alongside each vector BLOB — vectors from a different
// revision OR a different quantization are silently incomparable, and this is
// the staleness detector. DERIVED, never a hand-synced literal: change the pin
// or DTYPE and this changes with it.
export const model = `${REPO}@${PIN.slice(0, 8)}+${DTYPE}`;

let pipelinePromise = null;

// text → 1536 bytes (Float32 × 384), mean-pooled, L2-normalized. Input
// beyond the model's 512-token window is truncated by the tokenizer
// (pipeline default). The returned Uint8Array owns its buffer exactly —
// safe to store verbatim as a BLOB.
export async function embed(text) {
    // "model" resolves to <package>/model/ under env.localModelPath; DTYPE
    // q8 selects onnx/model_quantized.onnx (and is half the model identity).
    pipelinePromise ??= pipeline("feature-extraction", "model", { dtype: DTYPE });
    const extractor = await pipelinePromise;
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const data = output.data;
    if (!(data instanceof Float32Array) || data.length !== dimension) {
        throw new Error(`embed: expected Float32Array[${dimension}], got ${data?.constructor?.name}[${data?.length}]`);
    }
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}
