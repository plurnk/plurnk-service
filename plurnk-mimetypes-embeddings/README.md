# @plurnk/plurnk-mimetypes-embeddings

Opt-in embedder for [`@plurnk/plurnk-mimetypes`](https://github.com/plurnk/plurnk-mimetypes)' `embedding` channel (issue #24). Install it and the framework's loader finds it; nothing else to configure.

## Model

- **Xenova/all-MiniLM-L6-v2**, q8 quantized onnx (`onnx/model_quantized.onnx`), **384 dimensions**.
- Pinned revision: `751bff37182d3f1213fa05d7196b954e230abad9` (`.model-pin`).
- Model files are **bundled in the package** — no runtime network, ever. `env.allowRemoteModels = false` is set process-wide at import, and the loader is locked to the bundled `model/` directory. Integrity manifest in `model/model.sha256` (`npm run verify:model`).
- Inference runs on `@huggingface/transformers` (onnxruntime ships inside it).

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
import { embed, dimension } from "@plurnk/plurnk-mimetypes-embeddings";
const bytes = await embed("database connection error"); // Uint8Array(4 × dimension)
```

Input beyond the model's 512-token window is truncated by the tokenizer.

## Scripts

- `npm run build:model` — re-download the pinned revision into `model/` and regenerate `model/model.sha256`.
- `npm run verify:model` — check the committed model bytes against the manifest.
- `npm test` — unit (duck surface, determinism, normalization, cosine sanity) + integration (real framework loader path).
