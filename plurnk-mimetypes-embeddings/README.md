# @plurnk/plurnk-mimetypes-embeddings

Opt-in embedder for [`@plurnk/plurnk-mimetypes`](https://github.com/plurnk/plurnk-mimetypes)' `embedding` channel (issue #24). Install it and the framework's loader finds it; nothing else to configure.

## Model

- **Xenova/all-MiniLM-L6-v2**, q8 quantized onnx (`onnx/model_quantized.onnx`), **384 dimensions**.
- Pinned revision: `751bff37182d3f1213fa05d7196b954e230abad9` (`.model-pin`).
- Model files are **bundled in the package** — no runtime network, ever. Hermetic by construction: the embedder only reads local files, so there is no fetcher to disable. Integrity manifest in `model/model.sha256` (`npm run verify:model`).
- Inference runs on a **portable WASM runtime** — [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) (single-threaded, **vendored** — see below) for the onnx graph, [`@huggingface/tokenizers`](https://www.npmjs.com/package/@huggingface/tokenizers) for WordPiece. No native N-API addon: runs anywhere Node/Bun/Deno/edge runs, ships no per-platform binary, and leaks no event-loop handles (a process that embeds drains and exits on its own — plurnk-mimetypes#36). Output is vector-identical to the prior native (`onnxruntime-node`) path — same `model` identity, no re-embed.

## Vendored runtime (clean install, no install scripts)

`onnxruntime-web` is **vendored** into `vendor/onnxruntime-web/`, not pulled as an npm dependency. The reason: `onnxruntime-web` hard-depends on `protobufjs`, whose `postinstall` script trips dependency script-gates (lavamoat, pnpm `approve-builds`, hardened npm) — so a first install downstream would greet the user with a script-approval prompt. `protobufjs` is a **phantom**: the `.onnx` protobuf is parsed inside the wasm, never by the JS library (proven — `require.cache`/`moduleLoadList` report zero on a real `embed()`).

Vendoring ORT's own self-contained pre-built dist removes both `onnxruntime-web` and `protobufjs` from the install tree, so this package's runtime dependencies reduce to `@huggingface/tokenizers` and a consumer install runs **zero** install scripts. The committed bytes are reproducible from `.ort-pin` via `npm run vendor:ort` and gated by `npm run verify:ort` (checksum + phantom assertion, run in `pretest`). Full rationale, the bump runbook, and the `npm audit` blind-spot note: [`vendor/onnxruntime-web/PROVENANCE.md`](vendor/onnxruntime-web/PROVENANCE.md).

## Install

```sh
npm install @plurnk/plurnk-mimetypes-embeddings
```

## Usage

The framework resolves this package lazily when the `embedding` channel is requested:

```js
const result = await mimetypes.process(
    { content: "hello", hint: "text/plain" },
    { channels: ["embedding"] },
);
// result.embedding: Uint8Array, 1536 bytes — native-endian raw Float32 × 384,
// mean-pooled, L2-normalized. Store verbatim as a BLOB; cosine-rank over a
// Float32Array view. The same embed() serves entry bodies and query text.
```

Direct surface, if you want it without the framework:

```js
import { embed, dimension, model, maxTokens, countTokens } from "@plurnk/plurnk-mimetypes-embeddings";
const bytes = await embed("database connection error"); // Uint8Array(4 × dimension)
```

## Exports

- `embed(text) → Promise<Uint8Array>` — the 1536-byte vector (above), computed on the calling thread. The framework's per-entry path.
- `embedBatch(texts, { onProgress, signal }) → Promise<Uint8Array[]>` — embed many texts across a pool of single-threaded workers, returning vectors **in input order**. Each vector is **bit-identical** to `embed()` of the same text (workers are single-threaded; parallelism is data-parallel across them), so the `model` identity is unchanged. `onProgress({ completed, total })` fires as each finishes — the host's progress signal for a long corpus run. `signal` (`AbortSignal`) cancels in flight. The pool is lazy + persistent, unref'd while idle (the process still drains without `dispose()`), and torn down by `dispose()`. Pool size = `PLURNK_EMBED_WORKERS` (**required, no default**; each worker holds its own model copy, so it's a memory↔throughput dial you must set — ~6× at 8 workers, scales toward core count).
- `dimension` — `384`.
- `model` — the staleness identity (`Xenova/all-MiniLM-L6-v2@<pin>+q8`), **derived** from `.model-pin` + the quantization, never a hand-synced literal. Store it next to each vector; vectors from a different revision *or* quantization are silently incomparable.
- `maxTokens` — `512`, the model's token window.
- `countTokens(text) → Promise<number>` — token count in the model's **own** tokenizer, special tokens (CLS/SEP) included, **untruncated**. The losslessness primitive: a chunk embeds without truncation iff `countTokens(chunk) <= maxTokens`. A char/word proxy can't make that guarantee.

Input beyond the 512-token window is truncated by `embed()`; `maxTokens` + `countTokens` let a caller (e.g. plurnk-service's chunker) tile a larger body into window-sized chunks instead, losslessly. The framework re-exposes both via `mimetypes.embedderInfo()`.

For bulk corpus generation, feed the tiled chunks to `embedBatch` and forward `onProgress` to your operator surface — a large run becomes visible (N/total, %, ETA) and uses all cores, instead of a single-threaded, opaque freeze.

## Environment

- `PLURNK_EMBED_WORKERS` — **required, no default.** `embedBatch` pool size. Set to the core count on a dedicated box; lower it on a shared or low-RAM host (one model copy per worker). Unset, empty, or malformed → the embedder crashes on load (it will not guess a fallback). See `.env.example`.

## Scripts

- `npm run build:model` — re-download the pinned revision into `model/` and regenerate `model/model.sha256`.
- `npm run verify:model` — check the committed model bytes against the manifest.
- `npm run vendor:ort` — re-copy the onnxruntime-web runtime from `.ort-pin` into `vendor/` and regenerate `ort.sha256` (re-asserts the protobufjs-phantom invariant).
- `npm run verify:ort` — check the vendored runtime against its manifest and the phantom invariant (runs in `pretest`).
- `npm test` — unit (duck surface, determinism, normalization, cosine sanity, vendoring phantom guard) + integration (real framework loader path).
