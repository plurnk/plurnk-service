# antlrmap

Use ANTLR4 to generate repomaps for LLM agent context.

## Introduction

antlrmap is a Node.js utility that generates a structural map of all symbols in a codebase — classes, functions, methods, fields, and their parameters — formatted as JSON for LLM consumption.

Built on formal ANTLR4 grammars (EBNF-family `.g4` files) from the [Grammar Zoo](https://github.com/antlr/grammars-v4), antlrmap parses source files with real parsers, not regex. This makes it more thorough than ctags and more accessible than tree-sitter or LSPs. If you have a bespoke or obscure language, you can plug in your ANTLR4 grammar, write a mapping visitor, and you're good to go.

No Java dependency. The entire build and runtime is pure JavaScript.

## Supported Languages

JavaScript, TypeScript, Python, Rust, Go, Java, C, C++, Kotlin, PHP, Lua.

```bash
antlrmap --supported   # JSON of all languages and file extensions
```

## Installation

```bash
npm i -g @possumtech/antlrmap
```

## CLI Usage

```bash
# Map specific files
antlrmap lib/Parser.js lib/Formatter.js

# Pipe file lists from find, git, etc.
find src -name '*.ts' | antlrmap
git ls-files '*.py' | antlrmap

# Explicit stdin
antlrmap --stdin < filelist.txt
```

Output is JSON:

```json
[
  {
    "file": "lib/Parser.js",
    "symbols": [
      { "name": "Parser", "kind": "class", "line": 5, "endLine": 47 },
      { "name": "parse", "kind": "method", "line": 18, "endLine": 26, "params": ["source"] },
      { "name": "load", "kind": "method", "line": 28, "endLine": 46, "params": ["languageDir"] }
    ]
  }
]
```

## Module API

```js
import Antlrmap from "@possumtech/antlrmap";

const mapper = new Antlrmap();

// Map a batch of files (parser loaded once, reused across all files)
const results = await mapper.mapFiles(["src/index.js", "src/utils.js"]);

// Map a single file
const symbols = await mapper.mapFile("src/index.js");

// Map source text directly (no filesystem)
const symbols = await mapper.mapSource("class Foo { bar() {} }", ".js");

// Introspect supported languages
Antlrmap.supported;   // { "javascript--javascript": [".js", ".mjs"], ... }
Antlrmap.extensions;  // { ".js": "javascript--javascript", ... }
```

## What Gets Mapped

antlrmap lists all symbols that are defined in a file and which are not confirmed to be invisible outside the file, with their parameters. See [SPEC.md](SPEC.md) for the full policy.

**Included:** classes, functions, methods, fields, interfaces, enums, types, modules, exported variables — with parameter names.

**Excluded:** imports, exports (as standalone symbols), local variables, unexported module-scope variables (in languages with module privacy), usages, call graphs.

## Development

### Prerequisites

- Node.js 25+
- Git (with submodule support)

### Setup

```bash
git clone --recurse-submodules https://github.com/possumtech/antlrmap.git
cd antlrmap
npm install
npm run build    # compiles ANTLR4 grammars to JavaScript
```

### Build

`npm run build` compiles all active `.g4` grammars from the grammar zoo submodule into JavaScript parsers using [antlr-ng](https://github.com/nicotordev/antlr-ng) (a pure JS/TS port of the ANTLR4 tool). Output lands in `languages/<id>/generated/`. This is a build-time step — the published package ships precompiled parsers with no build required at install time.

```bash
npm run build                        # compile all 11 languages
node scripts/compile.js rust         # compile a single language
```

### Test

```bash
npm test                # e2e tests (maps own source, validates output)
npm run test:languages  # grammar zoo examples (359 files across 11 languages)
npm run test:all        # both
```

### Lint

```bash
npm run lint   # biome — checks lib/, scripts/, test/, languages/*/map.js
```

### Project Structure

```
lib/
  antlrmap.js         Public API (import Antlrmap from "@possumtech/antlrmap")
  index.js            CLI entry point
  Parser.js           Loads compiled grammar + mapping, parses source
  Formatter.js        Formats output as relative-path JSON

languages/<id>/
  map.js              Symbol extraction visitor for this language
  map.test.js         Grammar zoo example tests
  bases/              Hand-ported base classes (survives generated/ rebuild)
  generated/          Compiled ANTLR4 parser (gitignored, built by npm run build)

scripts/
  scaffold.js         Generates workspace stubs from the grammar zoo
  compile.js          Compiles .g4 grammars to JavaScript

vendor/grammars-v4/   Git submodule — the ANTLR4 grammar zoo
```

### Release

Releases are automated via GitHub Actions. To publish a new version:

```bash
npm version patch   # or minor, or major
git push --follow-tags
```

The `release.yml` workflow builds, tests, publishes to npm, and creates a GitHub Release.

### Grammar Zoo Updates

A scheduled workflow (`update-grammars.yml`) runs monthly, updates the grammars-v4 submodule to latest, rebuilds, tests, and opens a PR for review.

## Contributing

Providing mappings for all 380 grammars in the zoo is a work in progress. LLMs are effective at writing these mapping visitors, but many languages require contextual knowledge to get right, and some `.g4` grammars themselves need work.

To add a new language:

1. Find the grammar in `vendor/grammars-v4/`
2. Add a build config entry to `scripts/compile.js`
3. Write `languages/<id>/map.js` following the contract in [SPEC.md](SPEC.md)
4. Add `languages/<id>/map.test.js` pointing at the grammar zoo examples
5. Register file extensions in `lib/antlrmap.js`

## License

MIT
