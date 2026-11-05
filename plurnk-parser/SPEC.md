# @plurnk/plurnk-parser — SPEC

## §parser-build Package boundary, build, and Code Mode parser

`@plurnk/plurnk-parser` implements the PLURNK Code Mode language specified by `@plurnk/plurnk-contracts`. It owns `CodeMode`, `TargetSyntax`, `ScopeSyntax`, `MatcherSyntax`, the `PlurnkParser` tier entry points (`parse`, `parseStatements`, `stringify`), `parsePath`, and the `plurnk-parser` CLI.

- **Consumer boundary**: Only the service's execution path (`plurnk-core`, `plurnk-acp`, `plurnk-execs`) imports `@plurnk/plurnk-parser`. `@plurnk/plurnk-contracts` declares no dependency on `@plurnk/plurnk-parser`, `xpath`, or `json-p3`.
- **Code Mode parsing and serialization**: `CodeMode` partitions source into top-level Code Mode statement chunks and outside prose, parses declarative calls to `plurnk.<tool>(...)` and `<server>.<tool>(...)` with literal arguments into typed `PlurnkStatement` AST nodes, and serializes AST statements back into canonical unwrapped Code Mode syntax via `PlurnkParser.stringify`.
- **Build and installation gate**: `npm run build` compiles the package cleanly into `dist/`. `npm run test:installation` packs both `@plurnk/plurnk-contracts` and `@plurnk/plurnk-parser` tarballs, installs them into a clean consumer, and verifies all entry points, `parsePath`, the CLI, and browser-bundle compatibility.
