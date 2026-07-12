#!/usr/bin/env node
// Re-vendors onnxruntime-web's pre-built WASM runtime into vendor/onnxruntime-web/
// and writes vendor/onnxruntime-web/ort.sha256 — the manifest verify-ort.mjs
// checks. The committed runtime bytes ARE the package (model/ precedent); this
// script only exists to reproduce them from .ort-pin.
//
// We copy ORT's OWN self-contained web build (ort.wasm.min.mjs has zero bare
// imports) plus its wasm glue + binary — no bundler. protobufjs never comes
// along: it's a phantom dep of onnxruntime-web that the wasm inference path
// never loads (see vendor/onnxruntime-web/PROVENANCE.md). This script asserts
// that, failing hard if a future ORT version reintroduces a real protobufjs path.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The three files that constitute the runtime we load: the self-contained ESM
// build, its wasm glue loader, and the single SIMD-threaded binary (we run
// numThreads=1; the jsep/jspi/asyncify variants are never used).
const FILES = [
    "ort.wasm.min.mjs",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = (await readFile(path.join(repoRoot, ".ort-pin"), "utf-8")).trim();
if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error(`.ort-pin must be an onnxruntime-web version, got: ${pin}`);

const vendorDir = path.join(repoRoot, "vendor", "onnxruntime-web");
const tmp = await mkdtemp(path.join(tmpdir(), "vendor-ort-"));
try {
    // Pull just the onnxruntime-web tarball (no deps, no install scripts) and
    // extract its pre-built dist — the published bytes, reproducibly.
    execFileSync("npm", ["pack", `onnxruntime-web@${pin}`, "--pack-destination", tmp], { stdio: "inherit" });
    execFileSync("tar", ["-xzf", `onnxruntime-web-${pin}.tgz`], { cwd: tmp });
    const dist = path.join(tmp, "package", "dist");

    await mkdir(vendorDir, { recursive: true });
    const manifest = [];
    for (const file of FILES) {
        const bytes = new Uint8Array(await readFile(path.join(dist, file)));
        // Phantom guard: the JS we ship must not import/reference protobufjs.
        if (file.endsWith(".mjs") && Buffer.from(bytes).includes("protobuf")) {
            throw new Error(`${file} references protobuf — ORT ${pin} broke the phantom assumption; revisit PROVENANCE.md`);
        }
        await writeFile(path.join(vendorDir, file), bytes);
        const sha = createHash("sha256").update(bytes).digest("hex");
        manifest.push(`${sha}  ${file}`);
        console.log(`${file}: ${bytes.length} bytes sha256=${sha}`);
    }
    await writeFile(path.join(vendorDir, "ort.sha256"), `${manifest.join("\n")}\n`);
    console.log(`ort.sha256 written (${FILES.length} files, onnxruntime-web@${pin})`);
} finally {
    await rm(tmp, { recursive: true, force: true });
}
