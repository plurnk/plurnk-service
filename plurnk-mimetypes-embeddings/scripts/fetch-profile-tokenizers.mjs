#!/usr/bin/env node
// Reproduce the exact tokenizer bytes owned by built-in hosted embedding
// profiles. Existing pins remain fixed; a new profile records current main.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { constants, gzip as gzipCallback } from "node:zlib";

const FAMILIES = {
    cl100k: "Xenova/gpt-4",
    qwen3embed06: "Qwen/Qwen3-Embedding-0.6B",
    qwen3embed8: "Qwen/Qwen3-Embedding-8B",
    minilm: "Xenova/all-MiniLM-L6-v2",
};
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The MiniLM family is the bundled runtime's own vocabulary: its pin is the model pin, so a
// served copy of the same model (llama-server /v1/embeddings) counts tokens byte-exactly.
const PINS = { minilm: (await readFile(path.join(packageRoot, ".model-pin"), "utf8")).trim() };
const outputRoot = path.join(packageRoot, "profile-tokenizers");
const manifestPath = path.join(outputRoot, "manifest.json");
const prior = await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => null);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gzip = promisify(gzipCallback);

const fetchOk = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    return response;
};

const manifest = {};
for (const [family, repo] of Object.entries(FAMILIES)) {
    let pin = prior?.[family]?.pin ?? PINS[family];
    if (pin === undefined) pin = (await (await fetchOk(`https://huggingface.co/api/models/${repo}`)).json()).sha;
    if (!/^[0-9a-f]{40}$/u.test(pin ?? "")) throw new Error(`${repo}: Hugging Face returned no commit SHA`);
    const directory = path.join(outputRoot, family);
    await mkdir(directory, { recursive: true });
    const files = {};
    for (const name of ["tokenizer.json", "tokenizer_config.json"]) {
        const response = await fetch(`https://huggingface.co/${repo}/resolve/${pin}/${name}`);
        if (!response.ok) {
            if (name === "tokenizer_config.json" && response.status === 404) continue;
            throw new Error(`${response.status} ${response.statusText} for ${response.url}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(
            path.join(directory, `${name}.gz`),
            await gzip(bytes, { level: constants.Z_BEST_COMPRESSION }),
        );
        files[name] = sha256(bytes);
    }
    manifest[family] = {
        repo,
        pin,
        files,
        tokenizerId: files["tokenizer.json"].slice(0, 16),
    };
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
