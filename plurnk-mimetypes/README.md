# antlrmap

Use ANTLR4 to generate repomaps for LLM agent context.

## Introduction

antlrmap is a Node.js utility that generates a structural map of all symbols in a codebase — classes, functions, methods, fields, and their parameters — formatted as JSON for LLM consumption.

Built on formal ANTLR4 grammars (EBNF-family `.g4` files) from the [Grammar Zoo](https://github.com/antlr/grammars-v4), antlrmap parses source files with real parsers, not regex. This makes it more thorough than ctags and more accessible than tree-sitter or LSPs. If you have a bespoke or obscure language, you can plug in your ANTLR4 grammar, write a mapping visitor, and you're good to go.

No Java dependency. The entire build and runtime is pure JavaScript.

## Supported Languages

JavaScript, TypeScript, Python, Rust, Go, Java, C, C++, Kotlin, PHP, Lua, Markdown.

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
npm run build                        # compile all 12 languages
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

## Adding a Custom Language

antlrmap ships with 12 languages, but any language with an ANTLR4 grammar can be added — including your own proprietary or bespoke languages. You don't need to fork antlrmap or wait for upstream support.

### Quick start (grammar zoo language)

If the language has a grammar in the [ANTLR4 Grammar Zoo](https://github.com/antlr/grammars-v4):

```bash
# Clone with submodules to get the grammar zoo
git clone --recurse-submodules https://github.com/possumtech/antlrmap.git
cd antlrmap

npm install

# Scaffold the language
node scripts/init-language.js \
  --name smalltalk \
  --grammar-dir vendor/grammars-v4/smalltalk \
  --entry program \
  --extensions '.st'
```

This compiles the grammar, generates a starter `map.js` with all available visitor methods listed, and wires up tests. Open `languages/smalltalk/map.js` and implement the visitor methods for the language's declarations (see [SPEC.md](SPEC.md) for what to include and exclude).

### Quick start (custom grammar)

If you have your own `.g4` grammar files:

```bash
node scripts/init-language.js \
  --name my-dsl \
  --grammar-dir /path/to/my/grammar \
  --entry compilationUnit \
  --extensions '.dsl,.mydsl' \
  --out ./my-antlrmap-lang
```

### Using a custom language

**CLI** — point to the language directory:

```bash
antlrmap --lang-dir ./languages/smalltalk src/*.st
```

**Module API** — register before mapping:

```js
import Antlrmap from "@possumtech/antlrmap";

const mapper = new Antlrmap();
mapper.registerLanguage("smalltalk", {
  dir: "./languages/smalltalk",
  extensions: [".st"],
});

const results = await mapper.mapFiles(["src/main.st"]);
```

### Writing the map.js visitor

The generated `map.js` skeleton lists every visitor method available from the grammar. Your job is to implement the ones that correspond to definitions. The pattern is the same for every language:

1. **Identify the scope boundary** — the grammar rule that represents a function/method body. Override it to set `#inBody = true` so local declarations are suppressed.

2. **Override declaration visitors** — for each rule that represents a class, function, method, field, enum, etc., extract the name and call `#add(kind, name, ctx, params)`.

3. **Extract parameters** — for functions and methods, walk the parameter list rule to collect names.

See the [JavaScript map.js](languages/javascript--javascript/map.js) as a reference implementation and [SPEC.md](SPEC.md) for the full mapping policy.

LLMs are effective at writing these visitors — give them the `.g4` grammar file, the SPEC.md policy, and an existing map.js as a reference, and they can usually produce a working mapping.

### Testing

If the grammar zoo has example files, `init-language.js` automatically generates a test file:

```bash
node --test languages/smalltalk/map.test.js
```

## Contributing

Providing mappings for all 380 grammars in the zoo is a work in progress. Contributions of new language mappings are welcome. The `init-language.js` script does the heavy lifting — the main work is implementing the visitor in `map.js`.

To contribute a built-in language:

1. Run `init-language.js` to scaffold the language
2. Implement the visitor in `map.js` (follow [SPEC.md](SPEC.md))
3. Change `status` from `"todo"` to `"done"`
4. Add a build config entry to `scripts/compile.js`
5. Register file extensions in `lib/antlrmap.js`
6. Run `node --test languages/<id>/map.test.js` to verify

## License

MIT
