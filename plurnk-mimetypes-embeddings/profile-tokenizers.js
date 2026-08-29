import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "profile-tokenizers");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const engines = new Map();
const gunzip = promisify(gunzipCallback);

const entryFor = (family) => {
    const entry = manifest[family];
    if (entry === undefined) throw new Error(`Unknown embedding-profile tokenizer ${JSON.stringify(family)}`);
    return entry;
};

export const profileTokenizerFacts = (family) => {
    const entry = entryFor(family);
    return { family, tokenizerId: entry.tokenizerId };
};

const readJson = async (file) => JSON.parse((await gunzip(await readFile(`${file}.gz`))).toString("utf8"));

const engineFor = (family) => {
    const cached = engines.get(family);
    if (cached !== undefined) return cached;
    const entry = entryFor(family);
    const directory = path.join(root, family);
    const pending = Promise.all([
        import("@huggingface/tokenizers"),
        readJson(path.join(directory, "tokenizer.json")),
        entry.files["tokenizer_config.json"] === undefined
            ? Promise.resolve({})
            : readJson(path.join(directory, "tokenizer_config.json")),
    ]).then(([{ Tokenizer }, tokenizer, config]) => new Tokenizer(tokenizer, config));
    engines.set(family, pending);
    return pending;
};

export const countProfileTokens = async (family, text, { signal } = {}) => {
    if (typeof text !== "string") throw new TypeError("countProfileTokens: text must be a string");
    signal?.throwIfAborted();
    const engine = await engineFor(family);
    signal?.throwIfAborted();
    const count = engine.encode(text, { add_special_tokens: false }).ids.length;
    signal?.throwIfAborted();
    return count;
};

export const disposeProfileTokenizers = () => engines.clear();
