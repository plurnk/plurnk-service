# @plurnk/plurnk-providers-ollama

Ollama provider for [plurnk-service](https://github.com/plurnk/plurnk-service). Routes `ollama/{model[/registry]}` aliases through Ollama's OpenAI-compatible chat-completions endpoint.

## install

```
npm install @plurnk/plurnk-providers-ollama
```

Requires Node ≥ 25 (native TypeScript).

## use

plurnk-service constructs the provider via the static `fromEnv` factory (PROVIDERS.md §3.7). Direct construction is also supported.

```ts
import Ollama from "@plurnk/plurnk-providers-ollama";

const provider = await Ollama.fromEnv(process.env, "qwenzel:latest");

const result = await provider.generate({
    messages: [
        { role: "system", content: "You are a plurnk agent." },
        { role: "user",   content: "What is the capital of France?" },
    ],
});
```

## env

| Variable | Required | Notes |
|---|---|---|
| `OLLAMA_BASE_URL` | yes | Ollama server URL (e.g. `http://localhost:11434`) |
| `PLURNK_REASON` | no | Universal reasoning budget; any positive value toggles `think: true` on the request body |
| `PLURNK_PROVIDER_FETCH_TIMEOUT` | no | Universal fetch timeout in ms; default `600000` (10m) |

## context size

Dynamic, resolved at `fromEnv` time via `POST /api/show`. The sibling iterates `model_info` for any key matching `*.context_length` (Ollama keys it per-family: `qwen35.context_length`, `llama.context_length`, etc.). Throws if no such key is present.

## tokenization & pricing

- `countTokens`: family-dispatched. Llama-family models (llama / llama2 / llama3 / mistral / mixtral, detected via `/api/show` `details.family`) tokenize through [`llama-tokenizer-js`](https://www.npmjs.com/package/llama-tokenizer-js) — sync, pure JS, drop-in. Everything else (qwen, gemma, phi, deepseek, etc.) falls back to the chars/4 heuristic until per-family tokenizers land in pass-3. The dispatch decision is made once at `fromEnv` time and frozen on the instance.
- `costFor`: returns 0. Local Ollama models are free to operate; pico-dollar cost rollups always sum to zero.

## license

MIT.
