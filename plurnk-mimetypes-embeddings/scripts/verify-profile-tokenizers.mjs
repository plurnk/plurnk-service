#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(packageRoot, "profile-tokenizers");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const gunzip = promisify(gunzipCallback);
let failures = 0;
for (const [family, entry] of Object.entries(manifest)) {
    for (const [name, expected] of Object.entries(entry.files)) {
        const compressed = await readFile(path.join(root, family, `${name}.gz`)).catch(() => null);
        const bytes = compressed === null ? null : await gunzip(compressed);
        const actual = bytes === null ? "(missing)" : createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected) {
            failures += 1;
            console.error(`DRIFT ${family}/${name}: ${actual} != ${expected}`);
        }
    }
    if (entry.tokenizerId !== entry.files["tokenizer.json"].slice(0, 16)) {
        failures += 1;
        console.error(`DRIFT ${family}: tokenizerId does not derive from tokenizer.json SHA-256`);
    }
}
if (failures > 0) process.exit(1);
console.log(`OK — ${Object.keys(manifest).length} embedding-profile tokenizers verified byte-exact.`);
