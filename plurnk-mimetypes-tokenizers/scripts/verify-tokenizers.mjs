#!/usr/bin/env node
// Verifies the bundled tokenizer bytes against tokenizers/manifest.json —
// every recorded file must hash to its recorded sha256, and every family's
// tokenizerId must equal its tokenizer.json sha prefix. Exit 1 on any drift;
// wired into prepublishOnly so corrupted/edited vocab data cannot ship.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "tokenizers");
const manifest = JSON.parse(await readFile(path.join(outRoot, "manifest.json"), "utf-8"));

let bad = 0;
for (const [family, entry] of Object.entries(manifest)) {
    for (const [name, expected] of Object.entries(entry.files)) {
        const buf = await readFile(path.join(outRoot, family, name)).catch(() => null);
        const got = buf === null ? "(missing)" : createHash("sha256").update(buf).digest("hex");
        if (got !== expected) { bad += 1; console.error(`DRIFT ${family}/${name}: ${got.slice(0, 16)} != ${expected.slice(0, 16)}`); }
    }
    if (entry.tokenizerId !== entry.files["tokenizer.json"].slice(0, 16)) {
        bad += 1;
        console.error(`DRIFT ${family}: tokenizerId does not derive from tokenizer.json sha`);
    }
}

if (bad) { console.error(`\n${bad} drift(s).`); process.exit(1); }
console.log(`OK — ${Object.keys(manifest).length} families verified byte-exact against the manifest.`);
