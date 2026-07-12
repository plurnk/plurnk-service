#!/usr/bin/env node
// Downloads the pinned tokenizer.json set into tokenizers/<family>/ and writes
// tokenizers/manifest.json — pins (HF commit shas), sha256 per file, and each
// family's tokenizerId (sha256 prefix of the tokenizer.json bytes: the VOCAB
// identity, deliberately not a model id — plurnk-mimetypes#44). The committed
// bytes ARE the package (grammar-package precedent); this script only exists to
// reproduce them. Run with no pins file → pins CURRENT main and records it;
// with an existing manifest → re-fetches the recorded pins byte-exactly.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ungated sources only (Xenova/NousResearch/unsloth mirrors where the canonical
// repo is license-gated). The FAMILY key is what index.js' registry maps model
// refs onto; the repo is provenance.
const FAMILIES = {
    o200k: "Xenova/gpt-4o",
    cl100k: "Xenova/gpt-4",
    llama3: "NousResearch/Meta-Llama-3.1-8B",
    llama2: "NousResearch/Llama-2-7b-hf",
    gemma: "unsloth/gemma-2-9b",
    deepseek: "deepseek-ai/DeepSeek-V3",
    qwen: "Qwen/Qwen2.5-7B-Instruct",
    mistral: "unsloth/mistral-7b-instruct-v0.3",
    bert: "google-bert/bert-base-uncased",
    t5: "google-t5/t5-small",
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "tokenizers");
const manifestPath = path.join(outRoot, "manifest.json");

const prior = await readFile(manifestPath, "utf-8").then(JSON.parse).catch(() => null);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchOk(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res;
}

const manifest = {};
for (const [family, repo] of Object.entries(FAMILIES)) {
    // Pin: reuse the prior manifest's commit when present (reproduce), else
    // resolve current main via the HF API (advance) and record it.
    let pin = prior?.[family]?.pin;
    if (!pin) {
        const meta = await (await fetchOk(`https://huggingface.co/api/models/${repo}`)).json();
        pin = meta.sha;
        if (!/^[0-9a-f]{40}$/.test(pin ?? "")) throw new Error(`${repo}: HF API returned no commit sha`);
    }

    const dir = path.join(outRoot, family);
    await mkdir(dir, { recursive: true });
    const files = {};

    const tok = Buffer.from(await (await fetchOk(`https://huggingface.co/${repo}/resolve/${pin}/tokenizer.json`)).arrayBuffer());
    await writeFile(path.join(dir, "tokenizer.json"), tok);
    files["tokenizer.json"] = sha256(tok);

    // tokenizer_config.json is optional upstream — record reality, don't invent.
    const cfgRes = await fetch(`https://huggingface.co/${repo}/resolve/${pin}/tokenizer_config.json`);
    if (cfgRes.ok) {
        const cfg = Buffer.from(await cfgRes.arrayBuffer());
        await writeFile(path.join(dir, "tokenizer_config.json"), cfg);
        files["tokenizer_config.json"] = sha256(cfg);
    }

    manifest[family] = {
        repo,
        pin,
        files,
        // Vocab identity (#44): sha256 prefix of the tokenizer.json bytes.
        tokenizerId: files["tokenizer.json"].slice(0, 16),
    };
    console.log(`${family.padEnd(9)} ${repo}  pin=${pin.slice(0, 8)}  id=${manifest[family].tokenizerId}  (${(tok.length / 1024 / 1024).toFixed(1)}MB${files["tokenizer_config.json"] ? " +cfg" : ""})`);
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
console.log(`\nwrote ${manifestPath} — ${Object.keys(manifest).length} families`);
