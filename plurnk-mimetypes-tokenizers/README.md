# @plurnk/plurnk-mimetypes-tokenizers

Bundled LLM tokenizer vocabularies for
[@plurnk/plurnk-mimetypes](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes)'
tokenizer seam ({§mimetype-tokenizer}) — exact token counting for context-window
math.

## install

```sh
npm i @plurnk/plurnk-mimetypes-tokenizers
```

This is an optional artifact for deployments that need exact model-vocabulary
counters beyond the counter supplied by Plurnk's default local embedder. The
framework resolves it lazily by name; when it is absent, the seam degrades to a chars/2 estimate with a
`tokenizer_unavailable` Notice—never a silent estimate. The estimate is neither
exact nor a proven upper bound; correctness-sensitive consumers must reject it
or apply their own defensible policy. An installed artifact with an incompatible
surface fails hard.

## surface

- `resolve(modelRef) → Promise<{ countTokens(text, { signal? }): Promise<number>, tokenizerId } | null>` — a manifest family key or its exact pinned source ref selects a vocabulary. Every other value returns `null` (a data gap the seam degrades on, never a close-enough guess).
- `tokenizerId` — the **vocab** identity (tokenizer.json sha256 prefix), never a model id: refs sharing a vocabulary share the id, so a vocab-preserving model swap never invalidates stored counts keyed on `(content_hash, tokenizer_id)`.
- `countTokens` counts **content** tokens (`add_special_tokens: false`, the llama-server `/tokenize` semantics); BOS/EOS/chat-template framing is per-request overhead the host budgets separately.
- `dispose()` — drop constructed engines; re-lazy-init on next resolve.

## what's in here

One universal engine (`@huggingface/tokenizers` — WordPiece, byte-BPE, SentencePiece-BPE, Unigram from `tokenizer.json`) plus twelve bundled vocabularies under the pin/sha256 discipline (`tokenizers/manifest.json`; `npm run verify:tokenizers` checks byte-exactness, wired into `prepublishOnly`):

| family key | exact pinned source ref              |
|------------|--------------------------------------|
| o200k      | Xenova/gpt-4o                        |
| cl100k     | Xenova/gpt-4                         |
| llama3     | NousResearch/Meta-Llama-3.1-8B       |
| llama2     | NousResearch/Llama-2-7b-hf           |
| gemma      | unsloth/gemma-2-9b                   |
| deepseek   | deepseek-ai/DeepSeek-V3              |
| qwen       | Qwen/Qwen2.5-7B-Instruct             |
| qwen3embed06 | Qwen/Qwen3-Embedding-0.6B          |
| qwen3embed8  | Qwen/Qwen3-Embedding-8B            |
| mistral    | unsloth/mistral-7b-instruct-v0.3     |
| bert       | google-bert/bert-base-uncased        |
| t5         | google-t5/t5-small                   |

Hermetic: only local files are read, never a network. Missing families are an issue away — the registry extends by adding data, never by guessing.

## license

MIT. Bundled vocabularies are built from their upstream repos (pinned commits in `tokenizers/manifest.json`); see each for attribution.
