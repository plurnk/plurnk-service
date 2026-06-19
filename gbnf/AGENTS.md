# AGENTS.md — gbnf

`gbnf` is a **general, Node-native GBNF grammar utility**. It happens to live in the plurnk
organization, but it is *not* a plurnk component: it imports the ecosystem's *conventions*
(how the code looks, feels, and smells) without importing its *prerogatives* (the database,
the daemon, the schema-codegen pipeline, the env-config doctrine). When in doubt: match the
ecosystem's style, ignore the ecosystem's machinery.

**Identity rule — the tool must never identify as "plurnk."** The package name (`gbnf`), the
CLI (`gbnf`), the public API, and all shipped code in `src/` and `bin/` carry no plurnk
branding; anyone can `import … from "gbnf"` with no trace of the org. The plurnk ecosystem
appears only as (a) the documented *source* of conventions in this file and (b) real-world
*test-domain* data in `test/e2e/` (the `plurnk.gbnf` fixture and the digest-derived corpus —
exempt, since that is exactly the live situation the tool is measured against). Never let
plurnk identity leak into the importable artifact.

---

## 1. Charter (locked)

These are the original, non-negotiable project rules. Everything below serves them.

1. Obey the plurnk coding conventions (Node 25+, `export default class`, node-native
   testing under `test/intg` and `test/e2e`, etc.).
2. **Zero runtime dependencies.** The `dependencies` field stays empty.
3. **npx-friendly.** `npx gbnf …` must work with nothing compiled and nothing but
   Node installed.
4. **No build step for the TS/JS.** Node 25 strips types at runtime; `bin/` runs `.ts`
   directly from `src/`. There is no `dist/`, no bundler, no `tsconfig.build.json`. (The
   only thing `npm run build` compiles is the C reference oracle — see §10.)
5. **`SPEC.md` is anchored and bidirectionally covered.** Each contract promise carries a
   **markdown link** whose target is a **squiggle anchor** — e.g. a heading `### Rule
   Alternation` is bound with the link `[§rule_alternation](#rule-alternation)` (the markdown
   slug `#rule-alternation` is the clickable anchor; `§rule_alternation` is the join key).
   Tests covering that promise are named `[§rule_alternation]`. A script verifies the mapping
   both ways: every SPEC squiggle anchor has ≥1 test, every test squiggle exists in SPEC. (§9)
6. **`llama/`** holds llama.cpp's GBNF C code **copied verbatim, never confabulated**, then
   adapted into our `llama-gbnf.c` core. Provenance matters: it is a translation target, not
   inspiration. (§10)
7. **`build/`** is where the `llama-gbnf` executable is compiled via `npm run build`. (§10)
8. **All `test/e2e` assumes `llama-gbnf` is already compiled** in a sane, standard Ubuntu
   `build-essential` POSIX environment. The C binary is the oracle our TS implementation is
   differentially tested against. (§9, §10)
9. **`bin/`** exposes executable TypeScript (Node 25) files — *not* the C binaries. The C
   binary exists only as a rigorous translation/test reference.

---

## 2. NOT inherited from the ecosystem

The sibling repos (`plurnk-grammar`, `plurnk-service`) carry heavy machinery that is
**orthogonal** to a zero-dep grammar utility. Do **not** drag any of it in:

- ❌ **`node:sqlite` / SqlRite / `migrations/` / "the database is the application."** No DB.
- ❌ **JSON-Schema-2020-12 → TS codegen, `schema/` folder, `@cfworker/json-schema`,
  `json-schema-to-typescript`.** That's plurnk-grammar's protocol pipeline. We have no
  generated `types.generated.ts`.
- ❌ **ANTLR (`*.g4`, `antlr4ng`, `antlr-ng`), `src/generated/`, `fix-generated-imports`.**
  Our grammar engine is the hand-translated C-derived core, not an ANTLR parser.
- ❌ **`.env.example` as canonical config / `PLURNK_*` env vars / "every magic number lives
  in `.env`."** A zero-dep npx tool is configured by CLI flags (`parseArgs`), not an env
  cascade. Keep constants in code (`UPPER_SNAKE_CASE`) where they belong.
- ❌ **Daemon / WebSocket / RPC / `MethodRegistry` / scheme handlers / manifests / the actor
  boundary / digest forensics.** This is a library + CLI, not a service.
- ❌ **`@plurnk/*` exact-version peer pinning.** We have no deps to pin (Charter §2).
- ❌ **`plurnk.md` model-facing protocol doc.** We teach humans and machines via `README.md`
  and `SPEC.md` only.

If a future task seems to need any of the above, that is a signal you are solving the wrong
problem — stop and reconsider, don't import the prerogative.

---

## 3. Module system & Node

- **Node `>=25`.** Set `"engines": { "node": ">=25" }` in `package.json`.
- **ESM only.** `"type": "module"`. No CommonJS, no `require`, no `module.exports`.
- **`node:` prefix on every built-in**, always: `node:fs/promises`, `node:test`,
  `node:assert/strict`, `node:util`, `node:path`, `node:url`, `node:child_process`,
  `node:timers/promises`. No bare `fs`/`path`.
- **Global `fetch`** if ever needed (it won't be here) — never axios/node-fetch.
- Target **ES2024+**: logical assignment (`||=`, `??=`), top-level `await`, `import.meta`,
  `globalThis`, `Array.prototype.toSorted()`/`.toReversed()`.

---

## 4. TypeScript configuration

One `tsconfig.json`. **No `tsconfig.build.json`** (Charter §4 — nothing is emitted).

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "bin/**/*.ts", "scriptify/**/*.ts"]
}
```

- `strict: true` — no escapes.
- `noEmit: true` permanently. `tsc --noEmit` is the **lint pass** (no eslint, no biome,
  no prettier). It is the only thing `typescript` (a devDependency) is used for.
- `allowImportingTsExtensions: true` — source imports carry the `.ts` extension and run as-is.

> `typescript` is the one permitted **devDependency** (for `tsc --noEmit` lint), matching the
> siblings. Runtime `dependencies` stays empty (Charter §2). devDeps are not installed by
> `npx`, so this does not compromise npx-friendliness.

---

## 5. Folder layout

```
gbnf/
├── AGENTS.md             # this file — project memory & conventions
├── README.md             # human-facing: what it is, how to npx it
├── SPEC.md               # anchored contract (### Section - Part [section_part])
├── LICENSE
├── package.json
├── tsconfig.json
├── .gitignore
├── bin/                  # executable TS entrypoints (#!/usr/bin/env node) — §8
│   └── gbnf.ts           #   the `gbnf` CLI: validate input vs grammar → JSON verdict
├── src/                  # the native, zero-dep TS GBNF engine (port of llama-grammar.cpp)
│   ├── index.ts          #   validateGbnf(grammar, input) → tri-state Verdict
│   ├── GbnfParser.ts     #   byte-faithful GBNF text → rule table
│   ├── GbnfMatcher.ts    #   pushdown-stack matcher (init + accept)
│   ├── types.ts          #   GRETYPE + element/stack/Verdict types
│   └── *.test.ts         # unit tests live alongside the file they cover
├── test/
│   ├── intg/             # integration: engine + CLI contracts, no C binary
│   │   ├── engine.test.ts        #   [§verdict_*], [§grammar_*] via validateGbnf
│   │   ├── cli.test.ts           #   [§cli_*] by spawning bin/gbnf.ts
│   │   └── spec-coverage.test.ts #   enforces the SPEC ↔ test anchor bijection
│   └── e2e/              # differential harness vs the compiled llama-gbnf oracle
│       ├── _oracle.ts    #   wraps build/llama-gbnf → tri-state Verdict
│       ├── _corpus.ts    #   labeled (grammar, input, expectation) cases
│       ├── _harness.ts   #   validator registry + agreement engine
│       ├── differential.test.ts   #   corpus: TS vs oracle, position-exact
│       ├── fuzz.test.ts           #   seeded random + plurnk-shaped: TS vs oracle
│       └── fixtures/     #   echo.gbnf (controlled) + plurnk.gbnf (real snapshot)
├── llama/                # the C reference oracle — §10
│   ├── src/              #   llama.cpp GBNF engine + unicode (verbatim, fetched)
│   ├── tests/            #   no-model validator harness (verbatim, fetched)
│   └── shim/             #   hand-written stubs for the llama.cpp/ggml stack (committed)
├── build/                # compiled llama-gbnf oracle (gitignored) — `npm run build:llama`
├── scripts/              # shell scripts (fetchLlamaGrammar.sh, …), camelCase.sh — §10, §11
└── scriptify/            # one-off Node scripts — never build steps
    └── spec-coverage.ts  #   extracts §anchors from SPEC + tests for the bijection check
```

- **One class per file.** File name = class name, PascalCase: `GbnfParser.ts` →
  `export default class GbnfParser`.
- **Non-class utility files** are `kebab-case.ts` (e.g. `parse-rule.ts`), matching the
  sibling convention for helpers.
- **Unit tests alongside source** (`src/Foo.ts` ↔ `src/Foo.test.ts`). Integration and e2e
  tests live under `test/` (Charter §1).
- `llama/` and `build/`: `build/` is gitignored; `llama/` is committed (it's the documented
  translation source).

---

## 6. Class & code style

- `export default class Name {}` — one class per file. Static-only utility classes have no
  constructor; all methods `static`.
- **Private fields use `#`**, never the TS `private` keyword (TS `private` doesn't survive at
  runtime; `#` is real encapsulation). Same for `static #helper()`.
- `const` for everything; `let` only when reassignment is strictly required; **never `var`**.
- Guard clauses + early return. **No `else` after `return`/`throw`/`break`/`continue`.**
- Optional chaining `?.` and nullish coalescing `??` for genuinely-optional data — **not** as
  a way to paper over a contract violation (see §7).
- Template literals over concatenation. Shorthand properties/methods. Trailing commas in
  multi-line literals. Double quotes. Semicolons.
- Prefer declarative array methods (`.map`/`.filter`/`.reduce`/`.some`/`.every`/`.find`) and
  non-mutating `.toSorted()`/`.toReversed()` over imperative loops.
- `async`/`await` exclusively; `Promise.all`/`Promise.allSettled` for concurrency;
  `AbortController`/`AbortSignal` for anything cancellable.
- **Comments only warn about the hacky, exceptional, or surprising.** Never restate the code.
  A comment in `llama/`-derived code citing the upstream source line is the welcome exception.

---

## 7. Error handling — fail-hard

The ecosystem's defining trait. Adopt it fully:

- **Zero defensive coding.** Contracts are absolute. On a violated contract, crash
  immediately and loudly — do not recover, retry, log-and-continue, or fall back.
- **Surface root cause, never mask symptoms.** Errors are signals, not problems to suppress.
- Wrap-and-rethrow with `Error.cause` to preserve context:
  ```js
  throw new GbnfParseError(`unterminated rule at ${line}:${col}`, { cause });
  ```
- A custom `Error` subclass carries structured, serializable fields (`line`, `column`,
  source) — mirror `plurnk-grammar`'s `PlurnkParseError` shape:
  ```js
  export default class GbnfParseError extends Error {
    constructor(message, { line, column, cause } = {}) {
      super(message, { cause });
      this.name = "GbnfParseError";
      this.line = line;
      this.column = column;
    }
  }
  ```
- Never swallow a caught error: handle it or rethrow it.

---

## 8. `bin/` executables

- Shebang `#!/usr/bin/env node` on the first line; the file is executable TypeScript run
  directly under Node 25 (Charter §4, §9). `bin/` points at `.ts`, never at `dist/` or the
  C binary.
- **CLI parsing via `parseArgs` from `node:util`** — never yargs/commander.
- Emit JSON to stdout (pretty, 2-space) for machine consumption; diagnostics to stderr.
- **Exit codes**, matching the ecosystem: `0` success, `1` runtime/parse error, `64` usage
  error, `66` input/file not readable, `78` config/invalid-grammar error. `gbnf` overloads
  `0`/`1` as the verdict: `0` = accepted, `1` = rejected or incomplete.
- `package.json` `"bin"` maps the command name to the `.ts` entrypoint (no plurnk branding):
  ```json
  "bin": { "gbnf": "./bin/gbnf.ts" }
  ```

---

## 9. Testing

Native only: **`node --test` + `node:assert/strict`.** No mocha/jest/chai. Coverage via
`node --test --experimental-test-coverage`, floor **50% / 50% / 50%** (lines/branches/funcs).

Three tiers (Charter §1, §8):

| Tier | Location | Oracle | What it proves |
|------|----------|--------|----------------|
| **unit** | `src/**/*.test.ts` | none | isolated logic of one module |
| **intg** | `test/intg/*.test.ts` | none | our modules wired together |
| **e2e** | `test/e2e/*.test.ts` | compiled `llama-gbnf` C binary | our TS impl matches llama.cpp byte-for-byte |

- **e2e is differential.** A `Validator` answers `(grammarPath, input)` with a tri-state
  `Verdict` — `accept` / `incomplete` (valid prefix, premature EOF) / `reject` (bad char at a
  position). The harness asserts every validator in `VALIDATORS` agrees with the labeled
  corpus *and* with every other validator. The registry holds both the `oracle` and the
  native `ts` engine (`src/index.ts`), so the corpus is a live TS-vs-oracle cross-check;
  `fuzz.test.ts` extends it with seeded random + plurnk-shaped inputs (the oracle is ground
  truth, so no labels are needed). Corpus expectations are justified by external truth, never
  by what the oracle happens to emit. e2e presumes the binary is already compiled (Charter
  §8); a missing binary is a hard failure, not a skip.
- **Assertions are specific.** `assert.equal(actual, expected, msg)`,
  `assert.throws(fn, GbnfParseError, msg)`. Never a bare `assert.ok(result)` or a
  type-less `assert.throws(fn)` — assert the *correct outcome* and the *specific* error.
- **Spec anchors (Charter §5).** In `SPEC.md` a promise is bound with a markdown link to its
  squiggle anchor, `[§rule_alternation](#rule-alternation)`; tests cite the same squiggle:
  ```js
  test("[§rule_alternation] alternation lowers to a choice node", () => { … });
  ```
  A `scriptify/` script (run as a test, e.g. `test/intg/spec-coverage.test.ts`) extracts the
  `§…` squiggles from `SPEC.md`'s markdown links and from test names and enforces the
  bidirectional mapping, failing on any orphan or gap.
- Suggested scripts:
  ```json
  "test:lint": "tsc --noEmit",
  "test:unit": "node --test src/**/*.test.ts",
  "test:intg": "node --test test/intg/*.test.ts",
  "test:e2e":  "node --test test/e2e/*.test.ts",
  "test:all":  "npm run test:lint && npm run test:unit && npm run test:intg && npm run test:e2e"
  ```

---

## 10. The C reference oracle (`llama/`, `build/`)

Two stages, both shell-driven via npm scripts, neither touching any TS/JS:

- **`build:fetchLlamaGrammar` → `scripts/fetchLlamaGrammar.sh`** copies llama.cpp's GBNF
  source into `llama/` **verbatim, from a single pinned upstream commit (`LLAMA_SHA`), never
  confabulated** (Charter §6). It records provenance (upstream repo URL + pinned SHA + sha256
  per file) so any divergence we later introduce while adapting toward `llama-gbnf.c` is
  auditable.
- **Drift is a forcing function, not something to paper over.** The fetch first reads
  upstream `master`'s HEAD and **fails hard if it has moved past our pin.** We pin
  deliberately and re-pin deliberately — reviewing the upstream diff each time — rather than
  tracking the tip. Silently drifting would push the error out to users whose llama.cpp
  installs no longer match what we built and tested against; breaking *our* build first keeps
  that cost on us. Re-pinning is a conscious step: review, bump `LLAMA_SHA`, re-run, re-verify.
  CI runs this gate (it needs only `curl`, no toolchain) so upstream movement turns CI red
  promptly.
- **`build:llama` → `scripts/buildLlama.sh`** compiles `build/llama-gbnf` with the standard
  Ubuntu `build-essential` toolchain (Charter §7). It links the **verbatim** `llama/src`
  engine + `llama/tests` harness against the hand-written `llama/shim` headers, which stand in
  for the full llama.cpp/ggml stack on the null-vocab validator path (the only symbols
  `llama-grammar.cpp` needs externally: `GGML_ASSERT`/`GGML_ABORT`, two `LLAMA_LOG_*` macros,
  a `llama_vocab` with three never-reached token methods, and `llama_token`/
  `llama_token_data_array`). The vendored sources are **never edited** — all adaptation lives
  in `llama/shim`, which `fetch` never overwrites, so the drift gate keeps diffing cleanly.
  `build/` is gitignored. The binary takes `<grammar.gbnf> <input>` and reports accept/reject
  plus error position — no model involved.
- **`build` orchestrates** fetch-then-compile. These are the only builds in the repo and they
  touch no TS/JS.
- The binary exists solely as the **oracle** for `test/e2e` differential testing (Charter §9)
  — it is never shipped, never invoked by `bin/`, never an npx runtime dependency.

---

## 11. `scriptify/`

Two sibling buckets:

- **`scriptify/`** — one-off, deterministic **Node** scripts (the spec-coverage checker,
  corpus generators, etc.). Prefer a real Node script over a clever shell one-liner;
  generate-and-run rather than transform-by-inference.
- **`scripts/`** — **shell** scripts that orchestrate the POSIX toolchain (fetching and
  compiling the C oracle — §10). Filenames are `camelCase.sh`, e.g. `fetchLlamaGrammar.sh`.

`scriptify/` is never a build step and never invoked by `bin/` at runtime. `scripts/` is only
invoked through the `build:*` npm scripts.

---

## 12. Documentation roles

- **`AGENTS.md`** (this file): project memory — locked decisions, conventions, rationale.
  Read it before touching code.
- **`SPEC.md`**: the anchored contract. Promises bound with markdown links to squiggle
  anchors, `[§section_part](#section-part)`; tests cite `§section_part`; bidirectionally
  tested (§9, Charter §5).
- **`README.md`**: human-facing — what gbnf is and how to `npx` it. Keep it concrete and
  example-driven.

There is no `plurnk.md` here (§2).

---

## 13. Git, GitHub, CI & release

- **The agent owns all git and GitHub ceremony.** Stage, commit, push autonomously — **do not
  ask the user to confirm routine git/GitHub steps.** Surface a git matter only when it is
  genuinely necessary: an irreversible action on shared history (force-push, hard reset,
  rebase of pushed commits) where intent is ambiguous, or a conflict only the user can
  resolve. Routine ceremony is invisible to the user.
- **Solo dark project — commit straight to `main`, no PR ceremony.** Do not open pull requests
  for routine work; PRs add no value with a single author and one orchestrator. Just commit
  and push. (Use a short-lived branch only when a change genuinely needs isolation.)
- Conventional-commit subjects: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`,
  with an em-dash description, e.g. `feat: — translate llama char-range rule lowering`.
- Branch before committing to `main`.
- `.gitignore` covers `node_modules`, `build/`. `AGENTS.md`, `SPEC.md`, `scripts/`, and
  `llama/` are committed.
- **npm scripts are preferred to GitHub Actions whenever possible.** CI should be a thin
  wrapper that runs `npm run test:all` (and `npm run build` where a C toolchain is available);
  put real logic in `package.json` scripts, not in workflow YAML. Reach for an Actions
  workflow only for things npm genuinely cannot do locally.
- **Not published to npm yet.** Publishing is deferred; do not add `prepublishOnly`/`prepare`
  publish hooks or a `files` allowlist tuned for release until we decide to ship. npx-friendly
  (Charter §3) is a design property, not a present npm listing.

---

## 14. Quick checklist

A change "smells like plurnk" when it is:

1. Zero new runtime deps; npx still works with nothing built. (Charter §2, §3)
2. No TS build artifact; `bin/` runs `.ts` directly. (Charter §4)
3. `export default class`, one per file, `#private` fields, `const`-first, `node:` imports.
4. Fail-hard: contract violations crash with `Error.cause`, no fallbacks.
5. `node --test` + `assert/strict`, specific assertions, `[§anchor]`-named where it covers a
   spec promise, ≥50/50/50 coverage.
6. Any new `SPEC.md` promise has an anchor and a covering test; coverage script stays green.
7. e2e changes still differentially match the `build/llama-gbnf` oracle.
8. None of the §2 exclusions crept in.
