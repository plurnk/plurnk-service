// {§mimetype-tokenizer} Bundled LLM tokenizer vocabularies. ONE artifact package,
// not a plugin
// family: the engine (@huggingface/tokenizers) is universal — WordPiece,
// byte-BPE, SentencePiece-BPE, Unigram all load from tokenizer.json — so the
// per-model parts are pure data under the pin/sha256 discipline (manifest.json,
// fetch/verify scripts). Hermetic: only local files are read, never a network.
//
// Duck contract consumed by the framework's Tokenizers seam:
//   resolve(modelRef) → Promise<{ countTokens(text, { signal? }), tokenizerId } | null>
// null = no bundled vocab matches the ref (a data gap; the framework degrades
// explicitly according to {§mimetype-tokenizer}). tokenizerId is the VOCAB
// identity — the tokenizer.json sha256 prefix from the manifest — never a model
// id, so refs sharing a vocabulary share the id and a vocab-preserving model
// swap never invalidates counts derived against it.
//
// countTokens counts CONTENT tokens (add_special_tokens: false) — the same
// semantics as llama-server's /tokenize under {§mimetype-tokenizer}.
// BOS/EOS/chat-template overhead is per-request framing the host budgets
// separately; baking it into content counts would double-count it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@huggingface/tokenizers";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, "tokenizers", "manifest.json"), "utf-8"));

// Exact selector → family. The manifest owns both selectors the artifact can
// prove: its explicit family key and the pinned source repository whose bytes
// it verifies. Model-name resemblance is not vocabulary evidence (#173).
const EXACT_REFS = new Map(Object.entries(manifest).flatMap(([family, entry]) => [
    [family.toLowerCase(), family],
    [entry.repo.toLowerCase(), family],
]));

function familyFor(modelRef) {
    const wrapped = /^remote:(.+)@d[1-9][0-9]*$/i.exec(modelRef);
    const exactRef = wrapped?.[1] ?? modelRef;
    return EXACT_REFS.get(exactRef.toLowerCase());
}

// family → constructed Tokenizer, built once per process on first resolve.
const engines = new Map();

function engineFor(family) {
    const cached = engines.get(family);
    if (cached) return cached;
    const dir = path.join(here, "tokenizers", family);
    const tok = JSON.parse(readFileSync(path.join(dir, "tokenizer.json"), "utf-8"));
    const cfg = manifest[family].files["tokenizer_config.json"]
        ? JSON.parse(readFileSync(path.join(dir, "tokenizer_config.json"), "utf-8"))
        : {};
    const engine = new Tokenizer(tok, cfg);
    engines.set(family, engine);
    return engine;
}

export async function resolve(modelRef) {
    if (typeof modelRef !== "string" || modelRef.length === 0) {
        throw new TypeError(`resolve(modelRef): modelRef must be a non-empty string; got ${JSON.stringify(modelRef)}`);
    }
    const family = familyFor(modelRef);
    if (family === undefined) return null;
    const engine = engineFor(family);
    return {
        tokenizerId: manifest[family].tokenizerId,
        async countTokens(text, { signal } = {}) {
            signal?.throwIfAborted();
            const count = engine.encode(text, { add_special_tokens: false }).ids.length;
            signal?.throwIfAborted();
            return count;
        },
    };
}

// Drop the constructed engines; re-lazy-init on next resolve. Forwarded from
// Mimetypes.dispose().
export function dispose() {
    engines.clear();
}
