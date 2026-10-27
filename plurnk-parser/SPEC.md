# @plurnk/plurnk-parser — SPEC

## §parser-build Package boundary, build, and grammar artifacts

`@plurnk/plurnk-parser` implements the PLURNK language specified by `@plurnk/plurnk-contracts`. It owns the ANTLR grammars (`plurnkLexer.g4`, `plurnkParser.g4`), the generated lexer/parser/visitor, `FencePairing`, `HeadingReader`, `StatementShape`, `TargetSyntax`, `ScopeSyntax`, `MatcherSyntax`, `AstBuilder`, `PlurnkErrorStrategy`, `RecordingListener`, the `PlurnkParser` tier entry points (`parse`, `parseStatements`, `parseReasoningOperations`, `stringify`), `parsePath`, and the `plurnk-parser` CLI.

- **Consumer boundary**: Only the service's execution path (`plurnk-core`, `plurnk-acp`, `plurnk-execs`) imports `@plurnk/plurnk-parser`. `@plurnk/plurnk-contracts` declares no dependency on `@plurnk/plurnk-parser`, `antlr4ng`, `xpath`, or `json-p3`.
- **Shared heading and shape analysis**: `HeadingReader` and `StatementShape` supply one heading-recognition and body-role rule across `FencePairing`, normal admission, native tool-call recovery, and diagnostics.
- **Grammar build and installation gate**: `npm run build:grammar` regenerates `src/generated` from the `.g4` grammars via `antlr-ng`, failing the build on any ANTLR error and replacing the generated tree atomically. `npm run test:installation` packs both `@plurnk/plurnk-contracts` and `@plurnk/plurnk-parser` tarballs, installs them into a clean consumer, and verifies all entry points, `parsePath`, the CLI, and browser-bundle compatibility.
