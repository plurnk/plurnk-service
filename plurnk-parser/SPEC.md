# @plurnk/plurnk-parser — SPEC

## 1. What this package is

`@plurnk/plurnk-parser` implements the PLURNK language that
`@plurnk/plurnk-contracts` specifies. It owns the ANTLR grammars
(`plurnkLexer.g4`, `plurnkParser.g4`), the generated lexer, parser and visitor,
`AstBuilder`, the error strategy and the recording listener, the `PlurnkParser`
tier entry points, `parsePath`, and the `plurnk-parser` command line. It depends
on contracts for the AST and wire types, the schemas, `PathSyntax`,
`PlurnkParseError`, `TurnDisposition`, and the constants. Contracts
depends on nothing here.

§parser-consumers **Who imports the parser.** The service's execution path (core,
agui, execs) imports `PlurnkParser` and `parsePath` from this package.
`@plurnk/plurnk-contracts` exports neither and declares no parser dependency, so a
client that installs contracts installs no `antlr4ng`, `xpath`, or `json-p3`.

## §parser-build 2. Build and artifacts

`npm run build:grammar` regenerates `src/generated` from the grammars with
antlr-ng; generated files are artifacts, never edited, and are not tracked. The
build fails on any antlr error, since antlr-ng itself exits 0 over them, and it
replaces the generated tree whole or not at all, so a bad grammar edit can never
drill green over the previous lexer (#821).
`npm run build` emits `dist`. `npm run test:installation` packs the built parser
and contracts candidates, installs both into a clean consumer, verifies their
installed versions, and exercises every tier entry point, `parsePath`, the CLI,
and a browser-Worker bundle. Prepublication checks must not resolve the candidate
contracts version from the registry.
