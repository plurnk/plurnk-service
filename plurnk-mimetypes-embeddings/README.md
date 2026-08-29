# @plurnk/plurnk-mimetypes-embeddings

Portable local/hosted embedder for [`@plurnk/plurnk-mimetypes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes)' embedding seam ({§mimetype-embedding}).

| Concern      | Contract                                                                                                                                    |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| Installation | The default service composition installs this artifact as a required dependency; direct framework consumers install it when wanted.        |
| Resolution   | The framework lazily imports this fixed artifact; it does not scan for competing embedder packages.                                        |
| Computation  | `embedQuery()` encodes retrieval queries; `embedDocuments()` encodes an ordered corpus. Nothing embeds implicitly.                        |
| Configured   | `PLURNK_EMBEDDING_MODEL` selects any standard provider route or alias supported by `@plurnk/plurnk-providers`.                         |

## Bundled local model

- **Xenova/all-MiniLM-L6-v2**, q8 quantized onnx (`onnx/model_quantized.onnx`), **384 dimensions**.
- Pinned revision: `751bff37182d3f1213fa05d7196b954e230abad9` (`.model-pin`).
- Model files are **bundled in the package**. Local mode performs no runtime network: it reads only these files and has no fetcher to disable. Integrity manifest in `model/model.sha256` (`npm run verify:model`).
- Local inference runs on a **portable WASM runtime** — [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) (single-threaded, **vendored** — see below) for the onnx graph, [`@huggingface/tokenizers`](https://www.npmjs.com/package/@huggingface/tokenizers) for WordPiece. No native N-API addon: supported Node hosts receive the same package bytes, with no per-platform binary or leaked event-loop handles. Output is vector-identical to the prior native (`onnxruntime-node`) path — same `model` identity, no re-embed.

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

The framework resolves this artifact lazily. Its `embedding` process channel is
a query embedding; semantic-index derivation calls the explicit document
surface:

```js
const query = await mimetypes.process(
    { content: "database connection error", hint: "text/plain" },
    { channels: ["embedding"] },
);
const corpus = await mimetypes.embedDocuments([
    "The connection pool rejected a stale socket.",
    "The migration completed successfully.",
]);
```

Direct consumers use the same role-separated contract:

```js
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import {
    dimension,
    embedQuery,
    embedDocuments,
} from "@plurnk/plurnk-mimetypes-embeddings";

const { vector, metadata } = await embedQuery("database connection error");
const values = EmbeddingVector.decode(vector, dimension);
const { vectors } = await embedDocuments(["A database troubleshooting guide."]);
```

## Exports

- `embedQuery(text, { signal }) → Promise<{ vector, metadata }>` — encodes one retrieval query.
- `embedDocuments(texts, { onProgress, signal }) → Promise<{ vectors, metadata }>` — encodes an ordered corpus. The AI SDK partitions hosted calls against the adapter and exact-route profile envelopes while preserving input order; local mode uses a bounded worker pool. Progress and cancellation span the composed call.
- `metadata` — `{ inputTokens, warnings, accounting, providerMetadata?, responses? }`. Hosted usage, ordered physical-request accounting, provider evidence, and bounded response headers are preserved when supplied; raw response bodies are not retained. Local usage is explicitly `null` with an empty physical-request list, never estimated.
- `dimension`, `contextWindow`, and `tokenizerModel` — exact profile facts. Hosted construction never performs a paid inference to discover them.
- `model` — a stable vector-space identity derived from provider, model, dimensions, window, tokenizer, pooling, normalization, and query/document policy. Store it beside every vector; vectors with different identities are incomparable.
- `countTokens(text, { signal })` — local-only exact counting in the bundled model vocabulary. Hosted profiles expose `tokenizerModel` so the framework can resolve the corresponding exact bundled tokenizer independently.
- `dispose()` — releases the local runtime and every worker, attempting all teardown paths and aggregating failures. Concurrent calls join one attempt; later use resolves a fresh generation. Hosted mode is a no-op.

The bundled model is symmetric: query and document encodings of identical text
match. Qwen retrieval models are intentionally asymmetric: queries receive the
upstream retrieval instruction and documents remain unchanged. That role
policy is part of the vector-space identity.

## Provider routes

Unset `PLURNK_EMBEDDING_MODEL` selects the bundled hermetic MiniLM runtime.
Otherwise it accepts the same exact `<provider>/<model>` route or
`PLURNK_MODEL_<alias>` selector as generation. Endpoint overrides, catalog
credentials, custom provider declarations, retries, and alias scoping remain
owned by `@plurnk/plurnk-providers`; this package does not define a second HTTP
or authentication stack. Profiles whose exact counter is independently
resolved use the tokenizer artifact installed by the default service. Direct
framework compositions add that leaf explicitly:

```sh
npm install @plurnk/plurnk-mimetypes-tokenizers
```

Selection occurs before adapter import: local mode does not load provider
constructors, and configured mode does not load the bundled ONNX/tokenizer
runtime.

```dotenv
# Hosted catalog route
PLURNK_EMBEDDING_MODEL=cloudflare-workers-ai/@cf/qwen/qwen3-embedding-0.6b
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_KEY=...

# Operator-run OpenAI-compatible endpoint
PLURNK_PROVIDERS_PROVIDER_LOCAL_NPM=@ai-sdk/openai-compatible
PLURNK_MODEL_embeddings=local/Qwen/Qwen3-Embedding-0.6B
PLURNK_BASEURL_embeddings=http://127.0.0.1:8080/v1
PLURNK_EMBEDDING_MODEL=embeddings
```

Built-in profiles currently cover:

| Route | Dimensions | Input window | Inputs / request | Exact tokenizer |
|-------|-----------:|-------------:|-----------------:|-----------------|
| `cloudflare-workers-ai/@cf/qwen/qwen3-embedding-0.6b` | 1024 | 8192 | 1 | `Qwen/Qwen3-Embedding-0.6B` |
| `fireworks-ai/accounts/fireworks/models/qwen3-embedding-0p6b` | 1024 | 32768 | 1 | `Qwen/Qwen3-Embedding-0.6B` |
| `fireworks-ai/accounts/fireworks/models/qwen3-embedding-8b` | 4096 | 40960 | 1 | `Qwen/Qwen3-Embedding-8B` |
| `openrouter/qwen/qwen3-embedding-8b` | 4096 | 32768 | 1 | `Qwen/Qwen3-Embedding-8B` |
| `openai/text-embedding-3-small` | 1536 | 8191 | 36 | `cl100k` |

The Cloudflare row describes the current direct Workers AI model contract; the
separate AI Search integration publishes a smaller ingestion limit. Routes
without a published aggregate request envelope use one input per physical
request and recover throughput through bounded concurrency. OpenAI's 36-input
cap keeps the worst-case aggregate beneath its documented 300,000-token
request ceiling.

An unknown route is supported without guessing: declare all four exact facts
with `PLURNK_EMBEDDING_DIMENSIONS`, `PLURNK_EMBEDDING_CONTEXT_WINDOW`,
`PLURNK_EMBEDDING_TOKENIZER`, and
`PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST`. Such a profile is symmetric. A
built-in profile rejects these duplicate declarations so one fact retains one
owner.

`PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST` is the unknown route's standard
partition cardinality; it is transport policy, not vector-space identity.
`PLURNK_EMBEDDING_CONCURRENCY` independently bounds simultaneous hosted
requests after partitioning. `PLURNK_EMBEDDING_WORKERS` sizes only the local
document pool: empty leaves one core free on hosts larger than four cores, a
positive integer is exact, and `-1` claims every core. Each local worker owns a
model copy.

## Scripts

- `npm run build:model` — re-download the pinned revision into `model/` and regenerate `model/model.sha256`.
- `npm run verify:model` — check the committed model bytes against the manifest.
- `npm run vendor:ort` — re-copy the onnxruntime-web runtime from `.ort-pin` into `vendor/` and regenerate `ort.sha256` (re-asserts the protobufjs-phantom invariant).
- `npm run verify:ort` — check the vendored runtime against its manifest and the phantom invariant (runs before `test:unit`).
- `npm test` — unit (duck surface, determinism, normalization, cosine sanity, vendoring phantom guard) + integration (real framework loader path).
