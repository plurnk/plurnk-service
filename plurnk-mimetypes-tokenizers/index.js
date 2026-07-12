// Bundled LLM tokenizer vocabularies for @plurnk/plurnk-mimetypes' tokenizer
// seam (plurnk-mimetypes#44, SPEC §19). ONE artifact package, not a plugin
// family: the engine (@huggingface/tokenizers) is universal — WordPiece,
// byte-BPE, SentencePiece-BPE, Unigram all load from tokenizer.json — so the
// per-model parts are pure data under the pin/sha256 discipline (manifest.json,
// fetch/verify scripts). Hermetic: only local files are read, never a network.
//
// Duck contract consumed by the framework's Tokenizers seam:
//   resolve(modelRef) → Promise<{ countTokens(text), tokenizerId } | null>
// null = no bundled vocab matches the ref (a data gap; the seam degrades to its
// chars/2 upper bound with telemetry). tokenizerId is the VOCAB identity — the
// tokenizer.json sha256 prefix from the manifest — never a model id, so model
// refs sharing a vocabulary share the id and a vocab-preserving model swap
// never invalidates counts derived against it.
//
// countTokens counts CONTENT tokens (add_special_tokens: false) — the same
// semantics as llama-server's /tokenize, which the #44 measurements used.
// BOS/EOS/chat-template overhead is per-request framing the host budgets
// separately; baking it into content counts would double-count it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@huggingface/tokenizers";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, "tokenizers", "manifest.json"), "utf-8"));

// Model-ref → family. ORDER MATTERS: more specific patterns first (gpt-4o must
// hit o200k before the gpt-4 → cl100k rule; llama-3/4 before the llama-2
// catch-all). An unmatched ref returns null — the honest data gap; extend the
// table (and the bundled set) via issues, never by guessing a "close enough"
// vocab.
const REGISTRY = [
    { family: "o200k", match: /gpt-4o|gpt-4\.1|gpt-5|o200k|(^|[^a-z0-9])o[134](?![0-9])/i },
    { family: "cl100k", match: /gpt-4|gpt-3\.5|cl100k/i },
    { family: "llama3", match: /llama[-_ .]?[34]/i },
    { family: "llama2", match: /llama/i },
    { family: "gemma", match: /gemma/i },
    { family: "deepseek", match: /deepseek/i },
    { family: "qwen", match: /qwen|qwq/i },
    { family: "mistral", match: /mistral|mixtral|ministral|codestral/i },
    { family: "bert", match: /(^|[^a-z])bert/i },
    { family: "t5", match: /(^|[^a-z])t5/i },
];

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
    const entry = REGISTRY.find((e) => e.match.test(modelRef));
    if (entry === undefined) return null;
    if (!manifest[entry.family]) {
        // Registry names a family the manifest doesn't carry — a broken package
        // build, not a data gap. Crash, never degrade past a contract violation.
        throw new Error(`registry maps ${JSON.stringify(modelRef)} to family "${entry.family}" but the manifest carries no such tokenizer — rebuild via fetch:tokenizers`);
    }
    const engine = engineFor(entry.family);
    return {
        tokenizerId: manifest[entry.family].tokenizerId,
        async countTokens(text) {
            return engine.encode(text, { add_special_tokens: false }).ids.length;
        },
    };
}

// Drop the constructed engines; re-lazy-init on next resolve. Forwarded from
// Mimetypes.dispose().
export function dispose() {
    engines.clear();
}
