#!/usr/bin/env node
// Verifies the committed model/ bytes against the model.sha256 manifest
// written at fetch time. CI gate — fails hard on any drift.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = path.join(repoRoot, "model");
const manifest = await readFile(path.join(modelDir, "model.sha256"), "utf-8");

let failures = 0;
for (const line of manifest.trim().split("\n")) {
    const [expected, file] = line.split(/\s+/);
    const bytes = await readFile(path.join(modelDir, file));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual === expected) {
        console.log(`OK ${file}`);
    } else {
        console.error(`FAIL ${file}: expected ${expected}, got ${actual}`);
        failures += 1;
    }
}
if (failures > 0) process.exit(1);
console.log("OK: all model files match manifest");
