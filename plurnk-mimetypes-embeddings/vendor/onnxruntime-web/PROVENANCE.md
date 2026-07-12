# Vendored onnxruntime-web runtime

These files are copied **verbatim** from the published `onnxruntime-web` npm
package at the version in [`../../.ort-pin`](../../.ort-pin). They are not built
here and not modified. `npm run vendor:ort` reproduces them from the pin; `npm
run verify:ort` checks them against `ort.sha256` (run in `pretest`).

| File | Role |
|---|---|
| `ort.wasm.min.mjs` | ORT's self-contained web ESM build (zero bare imports) — the module `embed-core.js` imports |
| `ort-wasm-simd-threaded.mjs` | wasm glue loader |
| `ort-wasm-simd-threaded.wasm` | the SIMD-threaded wasm binary (we run `numThreads=1`; jsep/jspi/asyncify variants are unused and not vendored) |
| `ort.sha256` | per-file checksum manifest |

## Why vendored

`onnxruntime-web` declares **`protobufjs`** as a hard transitive dependency, and
`protobufjs` ships a `postinstall` script. That script is benign (a read-only
version-pin advisory) but its mere presence trips dependency script-gates
(lavamoat, pnpm `approve-builds`, hardened npm) — so a first install of anything
downstream (… → `@plurnk/plurnk-mimetypes-all` → `plurnk-service`) greets the
user with a script-approval prompt. There is no clean way to suppress it from a
transitive package: npm `overrides` are root-only, and every portable WASM
embedding stack (Transformers.js included) sits on this same `onnxruntime-web`.

Vendoring ORT's own pre-built dist removes `onnxruntime-web` (and therefore
`protobufjs`) from the install tree entirely. The package's runtime
`dependencies` reduce to `@huggingface/tokenizers` (pure WASM/JS, no scripts),
so a consumer install runs **zero** install scripts.

## The protobufjs-phantom invariant

`protobufjs` is **never loaded** on our inference path: the `.onnx` protobuf is
parsed inside the wasm (C++), not by the JS library. Verified two ways:

- The vendored `*.mjs` contain **zero** `protobuf` references (asserted by both
  `vendor-ort.mjs` at copy time and `verify-ort.mjs` at test time).
- A real `embed()` loads **no** protobufjs module — `require.cache` and
  `process.moduleLoadList` both report zero (guarded by the
  `protobufjs is never loaded at runtime` test in `index.test.js`).

If a future ORT version routes model loading through JS `protobufjs`, `vendor:ort`
and `verify:ort` fail loudly rather than silently shipping a broken or
script-bearing runtime. Re-evaluate this document before bumping past it.

## Maintainer runbook — bumping onnxruntime-web

1. Edit `.ort-pin` to the new version.
2. `npm run vendor:ort` — re-copies the three files, rewrites `ort.sha256`,
   re-asserts the phantom invariant.
3. `npm test` — the **vector-parity** test (`index.test.js`, native baseline,
   1e-5 tolerance) is the gate: identical model identity must yield unchanged
   vectors. If it drifts, stop — stored consumer vectors would be invalidated.
4. Commit the new `.ort-pin` + `vendor/onnxruntime-web/**` together.

> Blind spot: vendored ORT does not appear in `npm audit`. Check the
> `onnxruntime-web` advisory feed against `.ort-pin` when bumping (tracked
> alongside the family's grammar-pin freshness pass).
