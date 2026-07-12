#!/usr/bin/env node
// Verifies the committed vendor/onnxruntime-web/ bytes against the ort.sha256
// manifest written at vendor time, and re-asserts the protobufjs-phantom
// invariant the vendoring depends on. Test gate — fails hard on any drift.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(repoRoot, "vendor", "onnxruntime-web");
const manifest = await readFile(path.join(vendorDir, "ort.sha256"), "utf-8");

let failures = 0;
for (const line of manifest.trim().split("\n")) {
    const [expected, file] = line.split(/\s+/);
    const bytes = await readFile(path.join(vendorDir, file));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
        console.error(`FAIL ${file}: expected ${expected}, got ${actual}`);
        failures += 1;
        continue;
    }
    // The vendoring is only sound while the shipped JS never pulls protobufjs.
    if (file.endsWith(".mjs") && bytes.includes("protobuf")) {
        console.error(`FAIL ${file}: references protobuf — phantom invariant broken`);
        failures += 1;
        continue;
    }
    console.log(`OK ${file}`);
}
if (failures > 0) process.exit(1);
console.log("OK: vendored onnxruntime-web matches manifest, protobufjs-free");
