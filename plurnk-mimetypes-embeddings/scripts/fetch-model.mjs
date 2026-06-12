#!/usr/bin/env node
// Downloads the pinned Xenova/all-MiniLM-L6-v2 revision into model/ and
// writes model/model.sha256 — the manifest verify-model.mjs checks. The
// committed model bytes ARE the package (grammar-package precedent); this
// script only exists to reproduce them from the pin.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
// Exactly what transformers.js feature-extraction needs for local resolution
// with dtype q8 — probed against v4.2.0, not guessed.
const FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = (await readFile(path.join(repoRoot, ".model-pin"), "utf-8")).trim();
if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error(`.model-pin must be a HF commit SHA, got: ${pin}`);

const modelDir = path.join(repoRoot, "model");
const manifest = [];
for (const file of FILES) {
    const url = `https://huggingface.co/${MODEL_ID}/resolve/${pin}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dest = path.join(modelDir, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    manifest.push(`${sha}  ${file}`);
    console.log(`${file}: ${bytes.length} bytes sha256=${sha}`);
}
await writeFile(path.join(modelDir, "model.sha256"), `${manifest.join("\n")}\n`);
console.log(`model.sha256 written (${FILES.length} files, ${MODEL_ID}@${pin})`);
