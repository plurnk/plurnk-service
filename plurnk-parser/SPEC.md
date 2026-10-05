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
agui, execs) imports its parser surfaces from this package.
`@plurnk/plurnk-contracts` exports neither and declares no parser dependency, so a
client that installs contracts installs no `antlr4ng`, `xpath`, or `json-p3`.

`PlurnkParser.parseReasoningOperations` implements {§reasoning-operations}
using the same lexer, quotation pairing and AST admission. Nothing executes
in this package. Its optional advisory callback reports normalization warnings
only for the operations it admits.

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

§pinned-wording-parser **Pinned wording.** Verbatim sentences tests pin: each is contract, and a change here is a change of contract.

| sentence | arises when |
|---|---|
| `/*url*/` was read as the glob `*url*` over each line, the regex `/.*url.*/`; a pattern is a regex, and `*` repeats what precedes it. | a glob written where a regex is required: read, with this advisory ({§regex-dialect-readings}) |
| A pattern is a regex written `/pattern/flags`; escape a literal `*`, `+`, `?`, `(`, `[` or `.` with `\`. | the working form a broken regex's refusal carries ({§matcher-refusal}, {§parse-recovery}) |
