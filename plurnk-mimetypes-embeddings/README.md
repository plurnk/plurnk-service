# @plurnk/plurnk-mimetypes-embeddings

Portable local/remote embedder for [`@plurnk/plurnk-mimetypes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes)' embedding seam ({§mimetype-embedding}).

| Concern      | Contract                                                                                                                                    |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| Installation | The default service composition installs this artifact as a required dependency; direct framework consumers install it when wanted.        |
| Resolution   | The framework lazily imports this fixed artifact; it does not scan for competing embedder packages.                                        |
| Computation  | Only `embedding`, `embedBatch()`, or direct `embed()` requests produce vectors; the service search index requests them explicitly.          |
| External     | The same artifact can target an OpenAI-compatible embedding endpoint instead of executing the bundled local model.                         |

## Bundled local model

- **Xenova/all-MiniLM-L6-v2**, q8 quantized onnx (`onnx/model_quantized.onnx`), **384 dimensions**.
- Pinned revision: `751bff37182d3f1213fa05d7196b954e230abad9` (`.model-pin`).
- Model files are **bundled in the package**. Local mode performs no runtime network: it reads only these files and has no fetcher to disable. Integrity manifest in `model/model.sha256` (`npm run verify:model`).
- Local inference runs on a **portable WASM runtime** — [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) (single-threaded, **vendored** — see below) for the onnx graph, [`@huggingface/tokenizers`](https://www.npmjs.com/package/@huggingface/tokenizers) for WordPiece. No native N-API addon: supported Node hosts receive the same package bytes, with no per-platform binary or leaked event-loop handles (a process that embeds drains and exits on its own — plurnk-mimetypes#36). Output is vector-identical to the prior native (`onnxruntime-node`) path — same `model` identity, no re-embed.

## Vendored local runtime (clean install, no install scripts)

`onnxruntime-web` is **vendored** into `vendor/onnxruntime-web/`, not pulled as an npm dependency. The reason: `onnxruntime-web` hard-depends on `protobufjs`, whose `postinstall` script trips dependency script-gates (lavamoat, pnpm `approve-builds`, hardened npm) — so a first install downstream would greet the user with a script-approval prompt. `protobufjs` is a **phantom**: the `.onnx` protobuf is parsed inside the wasm, never by the JS library (proven — `require.cache`/`moduleLoadList` report zero on a real `embed()`).

Vendoring ORT's own self-contained pre-built dist removes both `onnxruntime-web` and `protobufjs` from the install tree, so this package's runtime dependencies reduce to `@huggingface/tokenizers` and a consumer install runs **zero** install scripts. The committed bytes are reproducible from `.ort-pin` via `npm run vendor:ort` and gated by `npm run verify:ort` (checksum + phantom assertion, run in `pretest`). Full rationale, the bump runbook, and the `npm audit` blind-spot note: [`vendor/onnxruntime-web/PROVENANCE.md`](vendor/onnxruntime-web/PROVENANCE.md).

## Install

Service users already receive this package. Direct framework consumers install
it to enable the embedding seam, or install it independently for its exported
surface:

```sh
npm install @plurnk/plurnk-mimetypes-embeddings
```

## Usage

With the bundled local mode, the framework resolves this package lazily when
the `embedding` channel is requested:

```js
const result = await mimetypes.process(
    { content: "hello", hint: "text/plain" },
    { channels: ["embedding"] },
);
// result.embedding: Uint8Array, 1536 canonical float32-le bytes × 384,
// mean-pooled and L2-normalized. Store verbatim as a BLOB. Decode through
// EmbeddingVector from @plurnk/plurnk-mimetypes. The same embed() serves entry
// bodies and query text.
```

Direct surface, if you want it without the framework:

```js
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import { embed, dimension, model, contextWindow, countTokens } from "@plurnk/plurnk-mimetypes-embeddings";
const bytes = await embed("database connection error"); // byteLength === 4 * dimension
const values = EmbeddingVector.decode(bytes, dimension);
```

## Exports

- `embed(text) → Promise<Uint8Array>` — a canonical little-endian binary32 `4 × dimension`-byte vector, computed on the calling thread in local mode or by one endpoint request in remote mode. The framework's per-entry path.
- `embedBatch(texts, { onProgress, signal }) → Promise<Uint8Array[]>` — returns vectors **in input order**, each **bit-identical** to `embed()` of the same text. Local mode schedules a shared pool of single-threaded workers; remote mode sends one request containing the full input array. `onProgress({ completed, total })` reports completion and `signal` (`AbortSignal`) cancels in flight. The local pool is lazy, persistent, unref'd while idle, and torn down by `dispose()`.
- `dimension` — `384` in local mode; probed from the configured endpoint in remote mode.
- `model` — the vector-space identity: derived from the local pin and quantization, or from the remote model declaration and probed dimension. Store it next to each vector; vectors from different identities are silently incomparable.
- `contextWindow` — `512` in local mode; operator-declared or absent in remote mode.
- `countTokens(text) → Promise<number>` — local-mode token count in the model's **own** tokenizer, special tokens (CLS/SEP) included, **untruncated**. Local counts use the same host-adaptive worker pool as `embedBatch`, so exact chunk planning scales across cores instead of blocking the daemon thread. The export is absent in remote mode because an OpenAI-compatible embedding endpoint does not expose its tokenizer. The local losslessness primitive is `countTokens(chunk) <= contextWindow`; a char/word proxy cannot make that guarantee.

In local mode, input beyond the 512-token window is truncated by `embed()`;
`contextWindow` + `countTokens` let a caller (e.g. plurnk-service's chunker)
tile a larger body into window-sized chunks instead, losslessly. The framework
re-exposes the available facts via `mimetypes.embedderInfo()`.

For bulk corpus generation, feed tiled chunks to `embedBatch` and forward `onProgress` to the operator surface. A large run remains visible and uses bounded data parallelism instead of becoming a single-threaded, opaque freeze.

## Environment

### Remote mode (#46)

Set `PLURNK_MIMETYPES_EMBED_BASE_URL` (OpenAI-convention `/v1` base; `/embeddings` is appended) to swap the bundled WASM embedder for an OpenAI-compatible endpoint — BYO GPU (llama-server, vLLM, hosted). `PLURNK_MIMETYPES_EMBED_MODEL` is **required** with it; `PLURNK_MIMETYPES_EMBED_API_KEY` optional (Bearer). Dimension is probed at load (unreachable endpoint = import crash = boot-time surfacing); identity becomes `remote:<model>@d<dim>` so a swap re-derives the space. No local tokenizer in remote mode: `countTokens` is absent; `contextWindow` comes from `PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW` when you declare it (the endpoint owner knows their model), else unknown — `embedderInfo()` reports the embedder as PRESENT either way, with the unknown facts explicitly null. `embedBatch` sends one request with the whole input array; `PLURNK_MIMETYPES_EMBED_WORKERS` is not required (no pool). Unset BASE_URL = local mode.

- `PLURNK_MIMETYPES_EMBED_WORKERS` — local `embedBatch` pool size. Unset uses all available cores, leaving one free on hosts larger than four cores; a positive integer sets an exact operator budget; `-1` explicitly claims every core. Each worker holds a model copy, so memory-constrained operators can lower the value.

## Scripts

- `npm run build:model` — re-download the pinned revision into `model/` and regenerate `model/model.sha256`.
- `npm run verify:model` — check the committed model bytes against the manifest.
- `npm run vendor:ort` — re-copy the onnxruntime-web runtime from `.ort-pin` into `vendor/` and regenerate `ort.sha256` (re-asserts the protobufjs-phantom invariant).
- `npm run verify:ort` — check the vendored runtime against its manifest and the phantom invariant (runs in `pretest`).
- `npm test` — unit (duck surface, determinism, normalization, cosine sanity, vendoring phantom guard) + integration (real framework loader path).
