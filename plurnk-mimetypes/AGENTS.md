# AGENTS.md — antlrmap Build Plan

## Overview

antlrmap parses source files using ANTLR4 grammars from the [Grammar Zoo](https://github.com/antlr/grammars-v4) (~308 languages) and emits a standardized repomap suitable for LLM agent context. Each language needs a **mapping script** that selects which parser rules constitute "symbols" (classes, functions, imports, etc.) for the repomap output.

---

## Phase 0 — Scaffold

### 0.1 Git Submodule

```bash
git submodule add https://github.com/antlr/grammars-v4.git vendor/grammars-v4
```

- Pin to a known commit tag for reproducibility.
- `.gitmodules` tracks it; CI clones with `--recurse-submodules`.
- The submodule is **read-only input** — never modify files inside it.

### 0.2 Architecture — npm Workspaces

Each language is an **independent workspace package** under `languages/`. The root package holds the CLI, runtime, and scripts. npm workspaces wires them together.

```
antlrmap/
├── package.json              # root — workspaces: ["languages/*"], CLI, runtime
├── vendor/
│   └── grammars-v4/          # git submodule (read-only)
├── languages/                 # each subfolder is its own workspace package
│   ├── javascript/
│   │   ├── package.json      # "@antlrmap/javascript"
│   │   ├── map.js            # symbol mapping implementation
│   │   ├── map.test.js       # tests against grammar zoo examples
│   │   └── generated/        # precompiled parser/lexer output
│   │       ├── JavaScriptLexer.js
│   │       └── JavaScriptParser.js
│   ├── java/
│   │   ├── package.json      # "@antlrmap/java"
│   │   └── map.js            # stub — status: "todo"
│   ├── python--python3/
│   │   ├── package.json      # "@antlrmap/python--python3"
│   │   └── map.js
│   ├── sql--postgresql/
│   │   ├── package.json      # "@antlrmap/sql--postgresql"
│   │   └── map.js
│   └── .../
├── lib/
│   ├── index.js              # CLI entry point
│   ├── Walker.js             # walks a repo, dispatches files to parsers
│   ├── Parser.js             # wraps antlr4 runtime, loads grammar, invokes mapping
│   └── Formatter.js          # emits the final repomap format
├── scripts/
│   ├── scaffold.js           # generates language workspaces from grammar zoo
│   └── compile.js            # precompiles .g4 → generated/ per workspace
├── AGENTS.md
├── SPEC.md
└── README.md
```

### 0.3 Why Workspaces

- **Scoped builds**: `npm run build -w languages/javascript` — compile one grammar, not 308.
- **Scoped tests**: `npm run test -w languages/javascript` — test one language in isolation.
- **Independent publishing**: users `npm install @antlrmap/javascript` for just what they need. The root `antlrmap` CLI depends on whichever language packs are `status: "done"`.
- **Contained dependencies**: if a grammar needs a custom lexer base or unusual dependency, it stays in that workspace.
- **Parallel CI**: each workspace can be built/tested independently in CI matrix jobs.

The root `package.json` declares `"workspaces": ["languages/*"]`. Stub packages (status: `todo`) have no dependencies — they add no install overhead.

---

## Phase 1 — Scaffold Script (`scripts/scaffold.js`)

A deterministic Node.js script that reads the grammar zoo and generates the `languages/` directory. This is the first thing to build.

### 1.1 Discovery Algorithm

1. Read every top-level directory in `vendor/grammars-v4/`, skipping infrastructure dirs (`.github`, `.config`, `.claude`, `_scripts`).
2. For each directory, determine if it is a **leaf grammar** (contains `.g4` files directly) or a **parent** (contains subdirectories that themselves contain `.g4` files).
   - **Leaf** (e.g., `json/`): grammar id = `json`.
   - **Parent** (e.g., `sql/postgresql/`): grammar id = `sql--postgresql` (double-hyphen delimiter).
3. Collect every leaf into a sorted manifest.

### 1.2 Manifest Output

Write `languages/manifest.json` — the canonical registry of all grammars:

```json
[
  {
    "id": "json",
    "grammarDir": "vendor/grammars-v4/json",
    "g4Files": ["JSON.g4"],
    "status": "todo"
  },
  {
    "id": "sql--postgresql",
    "grammarDir": "vendor/grammars-v4/sql/postgresql",
    "g4Files": ["PostgreSQLLexer.g4", "PostgreSQLParser.g4"],
    "status": "todo"
  }
]
```

`status` is one of: `todo`, `draft`, `done`, `skip`.

### 1.3 Workspace Stub Generation

For each manifest entry, create `languages/<id>/` as a workspace package if it does not already exist.

**`languages/<id>/package.json`**:

```json
{
  "name": "@antlrmap/<id>",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "node ../../scripts/compile.js <id>",
    "test": "node --test"
  }
}
```

`private: true` until the mapping is done and ready for publishing.

**`languages/<id>/map.js`**:

```js
// TODO: implement symbol mapping for <id>
// Grammar files: <list of .g4 files>
export default class Map {
  static status = "todo";

  /** @param {import("antlr4").ParserRuleContext} tree */
  static extract(tree) {
    return [];
  }
}
```

The script must be **idempotent** — re-running it after new grammars appear in the zoo adds new stubs without overwriting existing work. Existing `map.js` and `package.json` files are never touched.

### 1.4 Root package.json Scripts

```json
"workspaces": ["languages/*"],
"scripts": {
  "scaffold": "node scripts/scaffold.js",
  "build": "npm run build --workspaces --if-present",
  "test": "node --test && npm run test --workspaces --if-present"
}
```

- `npm run build` fans out to every workspace that has a `build` script (stubs don't).
- `npm run build -w languages/javascript` compiles just one.
- `--if-present` skips workspaces whose `package.json` hasn't been updated with a real build yet.

### 1.5 Compilation Script (`scripts/compile.js`)

Precompiles `.g4` files into JavaScript parser/lexer modules. Invoked per-workspace: `node ../../scripts/compile.js <id>`. Output lands in `languages/<id>/generated/`.

- The ANTLR4 tool (Java CLI or `antlr4-tool` npm wrapper) is a root **devDependency**.
- Reads the manifest to find the grammar's `.g4` files and source directory.
- Skips grammars with `status` of `todo` or `skip`.
- For Milestone 0, only `javascript` has a non-stub `map.js`, so only it compiles.

---

## Phase 2 — Core Runtime (`lib/`)

### 2.1 Parser.js

- Accepts a grammar id and source text.
- Dynamically imports the workspace package: `import("@antlrmap/<id>")` resolves via npm workspaces to `languages/<id>/`.
- Loads the precompiled Lexer/Parser from `generated/`, feeds source text, produces a parse tree.
- Dependency: `antlr4` npm package (the official JS/TS runtime) — a root dependency shared by all workspaces.

### 2.2 Walker.js

- Accepts a root directory path and a file-extension-to-grammar-id mapping (the extension registry).
- Walks the directory, dispatches each file to `Parser.js` by matching its extension.
- Passes each resulting parse tree through the workspace's `map.js` → `Map.extract(tree)`.
- Collects all extracted symbols.

### 2.3 Formatter.js

- Takes the collected symbols and emits the repomap output format.
- Format TBD in SPEC.md, but minimally: file path, symbol name, symbol kind (class/function/import/etc.), line number.

### 2.4 index.js (CLI)

- Uses `parseArgs` from `node:util`.
- Accepts a target directory and optional language filter.
- Wires Walker → Parser → map.js → Formatter → stdout.

---

## Phase 3 — Mapping Scripts

This is the long tail — 308 languages, each needing a `Map.extract()` implementation that walks the ANTLR parse tree and picks out the relevant symbol rules.

### 3.1 Mapping Contract

Every `map.js` must export a default class with:

```js
static extract(tree) → Symbol[]
```

Where `Symbol` is:

```js
{ name: string, kind: string, line: number, endLine: number }
```

`kind` values are standardized: `class`, `function`, `method`, `interface`, `import`, `export`, `type`, `constant`, `variable`, `module`, `enum`.

### 3.2 Prioritization

Not all 308 grammars are equal. Triage by usage frequency:

| Tier | Languages | Target |
|------|-----------|--------|
| **P0** | javascript, typescript, python, java, go, rust, c, cpp, csharp, ruby, php, swift, kotlin | First — most repos |
| **P1** | sql dialects, html, css, bash, lua, scala, haskell, elixir, dart, r, perl, shell | Second — common in mixed repos |
| **P2** | Everything else | Community / LLM-assisted |

### 3.3 LLM-Assisted Mapping Workflow

For each grammar, the mapping task is well-scoped enough for an LLM agent:

1. Read the `.g4` file(s) for the grammar.
2. Identify parser rules that represent top-level declarations (functions, classes, imports, etc.).
3. Write the `Map.extract()` body that walks `tree` and collects those rules.
4. Validate against the `examples/` directory in the grammar zoo.

This can be parallelized across languages with a script that feeds each grammar to an agent session.

---

## Phase 4 — Testing

### 4.1 Scaffold Tests

- `scripts/scaffold.test.js` — verify manifest generation and stub creation against a mock grammar zoo directory.

### 4.2 Per-Language Tests (workspace-scoped)

- Each `languages/<id>/map.test.js` parses known source from `vendor/grammars-v4/<path>/examples/` and asserts the expected symbols.
- Run one: `npm run test -w languages/javascript`.
- Run all implemented: `npm run test --workspaces --if-present` — stubs have no test script, so they're skipped.

### 4.3 Integration

- `test/integration/` — end-to-end: point antlrmap at a real multi-language repo, assert the output contains expected symbols.

---

## Build Order

### Milestone 0 — JS Dogfood

| Step | Deliverable | Depends On |
|------|-------------|------------|
| 1 | `git submodule add` grammars-v4 | — |
| 2 | `scripts/scaffold.js` | submodule |
| 3 | Run scaffold → `languages/` populated with stubs | scaffold script |
| 4 | Precompile JavaScript grammar → `languages/javascript/` | submodule, antlr4 tooling |
| 5 | `languages/javascript/map.js` — real implementation | compiled grammar |
| 6 | `lib/Parser.js` — load precompiled grammar, parse source | step 4 |
| 7 | `lib/Formatter.js` — JSON output | — |
| 8 | `lib/Walker.js` — walk dir, match `.js`, dispatch | Parser, Formatter |
| 9 | `lib/index.js` — CLI wiring | Walker |
| 10 | Run on self, validate output | all above |

### After Milestone 0

| Step | Deliverable | Depends On |
|------|-------------|------------|
| 11 | Remaining P0 mapping scripts (TS, Python, Java, ...) | milestone 0 |
| 12 | Per-language tests using grammar zoo examples | step 11 |
| 13 | Integration tests | step 12 |
| 14 | P1/P2 mappings | ongoing |

---

## Milestone 0 — JavaScript First (Dogfood Target)

Before expanding to 308 languages, prove the entire pipeline end-to-end on **JavaScript only**. This lets antlrmap recursively map its own codebase.

### Deliverables

1. Submodule added, scaffold script written and run.
2. `languages/javascript/map.js` — fully implemented, not a stub.
3. `lib/Parser.js` — compiles and loads the JS grammar (precompiled).
4. `lib/Walker.js` — walks a directory, matches `.js` → `javascript`.
5. `lib/Formatter.js` — emits JSON repomap.
6. `lib/index.js` — CLI: `antlrmap .` produces a repomap of the current directory.
7. **Validation**: run `antlrmap` on its own `lib/` and `scripts/` directories, confirm the output captures all classes, functions, imports, and exports.

### Success Criteria

```bash
node lib/index.js .
# → JSON output listing every symbol in antlrmap's own source
```

Once this works, expanding to TypeScript/Python/etc. is just adding more `map.js` implementations — the scaffold already has every stub waiting.

---

## npm Release Strategy

### Root package: `antlrmap`

Published as `@possumtech/antlrmap`. Ships the CLI and runtime only.

```json
{
  "name": "@possumtech/antlrmap",
  "bin": { "antlrmap": "lib/index.js" },
  "files": ["lib/"],
  "dependencies": { "antlr4": "..." }
}
```

- No language packs bundled — users install what they need.
- `vendor/`, `scripts/`, `languages/` are all excluded from the published tarball.

### Language packs: `@antlrmap/<id>`

Each workspace publishes independently. Ships only the precompiled parser and mapping.

```json
{
  "name": "@antlrmap/<id>",
  "files": ["map.js", "generated/"],
  "peerDependencies": { "antlr4": "..." }
}
```

- `files` whitelist ensures `.g4` source, tests, and vendor paths never ship.
- `antlr4` is a **peerDependency** — the root CLI provides it, avoiding duplication.
- `private: true` on stubs prevents accidental publish. Remove when `status: "done"`.

### Install experience

```bash
# CLI
npm i -g @possumtech/antlrmap

# language packs — install per-project or globally
npm i -g @antlrmap/javascript @antlrmap/python--python3
```

The CLI discovers installed `@antlrmap/*` packages at runtime to know which languages are available.

---

## Decisions

- **Repomap output format**: JSON.
- **Grammar compilation**: Precompile at build time. Ship lean compiled parsers — no runtime ANTLR compilation, minimal production dependencies.
- **File extension registry**: Ship a default extension → grammar-id map. Support user overrides for alternate grammars or custom grammars/mappers.
- **Custom lexer bases**: Best-effort — use them where they work without adding dependency complexity. Failure is an option; skip and mark `status: "skip"` if a grammar's support code is too entangled.
