# @plurnk/plurnk-mimetypes-tokenizers

Bundled LLM tokenizer vocabularies for [@plurnk/plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes)' tokenizer seam (SPEC §19) — exact token counting for context-window math.

## install

```
npm i @plurnk/plurnk-mimetypes-tokenizers
```

Opt-in artifact package: the framework resolves it lazily by name; absent, the seam degrades to a chars/2 upper bound with a `tokenizer_unavailable` telemetry event — never a silent estimate.

## surface

- `resolve(modelRef) → Promise<{ countTokens(text): Promise<number>, tokenizerId } | null>` — `null` when no bundled vocabulary matches the ref (a data gap the seam degrades on, never a close-enough guess).
- `tokenizerId` — the **vocab** identity (tokenizer.json sha256 prefix), never a model id: refs sharing a vocabulary share the id, so a vocab-preserving model swap never invalidates stored counts keyed on `(content_hash, tokenizer_id)`.
- `countTokens` counts **content** tokens (`add_special_tokens: false`, the llama-server `/tokenize` semantics); BOS/EOS/chat-template framing is per-request overhead the host budgets separately.
- `dispose()` — drop constructed engines; re-lazy-init on next resolve.

## what's in here

One universal engine (`@huggingface/tokenizers` — WordPiece, byte-BPE, SentencePiece-BPE, Unigram from `tokenizer.json`) plus ten bundled vocabularies under the pin/sha256 discipline (`tokenizers/manifest.json`; `npm run verify:tokenizers` checks byte-exactness, wired into `prepublishOnly`):

| family | routes refs like | source (ungated) |
|---|---|---|
| o200k | gpt-4o, gpt-4.1, gpt-5, o1/o3/o4 | Xenova/gpt-4o |
| cl100k | gpt-4, gpt-3.5 | Xenova/gpt-4 |
| llama3 | llama-3.x, llama-4 | NousResearch/Meta-Llama-3.1-8B |
| llama2 | llama-2, bare llama | NousResearch/Llama-2-7b-hf |
| gemma | gemma-* | unsloth/gemma-2-9b |
| deepseek | deepseek-* | deepseek-ai/DeepSeek-V3 |
| qwen | qwen*, qwq | Qwen/Qwen2.5-7B-Instruct |
| mistral | mistral, mixtral, ministral, codestral | unsloth/mistral-7b-instruct-v0.3 |
| bert | bert-* (not roberta) | google-bert/bert-base-uncased |
| t5 | t5, flan-t5 | google-t5/t5-small |

Hermetic: only local files are read, never a network. Missing families are an issue away — the registry extends by adding data, never by guessing.

## license

MIT. Bundled vocabularies are built from their upstream repos (pinned commits in `tokenizers/manifest.json`); see each for attribution.
